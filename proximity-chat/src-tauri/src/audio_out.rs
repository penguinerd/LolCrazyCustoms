//! "App audio" output: the peers' voices played by THIS process (lolproxchat.exe),
//! not by WebView2's own audio service process.
//!
//! Why: everything WebView2 plays comes out of a separate msedgewebview2.exe
//! audio process, which OBS's "Application Audio Capture" cannot pick up — a
//! streamer could not put the voice chat on its own track. With app audio on,
//! the page mixes the voices in a silent Web Audio graph and sends the mix here
//! in 10 ms chunks of mono f32; this module plays it on the chosen output
//! device through WASAPI (cpal), so Windows and OBS see lolproxchat.exe playing it.
//!
//! The audio runs on a thread of its own because a cpal stream must stay on the
//! thread that made it. Between the page and the device sits a small jitter
//! buffer (`Jitter`): it waits for TARGET_MS of audio before playing, refills
//! the same way after running dry, and skips a sample now and then when it
//! holds too much, so the two clocks (the page's and the sound card's) never
//! drift into a growing delay.

use std::collections::VecDeque;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

/// Audio held before playing starts (and after running dry).
const TARGET_MS: usize = 40;
/// Most audio held; past it the oldest is dropped (the page stalled, then
/// caught up all at once).
const MAX_MS: usize = 250;

/// The jitter buffer between the page's chunks and the device's callbacks.
pub struct Jitter {
    buf: VecDeque<f32>,
    target: usize,
    max: usize,
    playing: bool,
    pub underruns: u64,
    pub dropped: u64,
}

impl Jitter {
    pub fn new(sample_rate: u32) -> Self {
        let per_ms = sample_rate as usize / 1000;
        Jitter {
            buf: VecDeque::with_capacity(per_ms * MAX_MS * 2),
            target: per_ms * TARGET_MS,
            max: per_ms * MAX_MS,
            playing: false,
            underruns: 0,
            dropped: 0,
        }
    }

    /// Audio from the page.
    pub fn push(&mut self, samples: &[f32]) {
        self.buf.extend(samples.iter().copied());
        if self.buf.len() > self.max {
            // Keep the newest TARGET_MS: late audio is worse than a skip.
            let extra = self.buf.len() - self.target;
            self.buf.drain(..extra);
            self.dropped += extra as u64;
        }
    }

    /// Fills `out` for the device: silence until TARGET_MS is held, then the
    /// audio; silence again (and a refill) if it runs dry.
    pub fn pull(&mut self, out: &mut [f32]) {
        if !self.playing {
            if self.buf.len() < self.target {
                out.fill(0.0);
                return;
            }
            self.playing = true;
        }
        // Holding much more than the target means the page's clock runs a
        // little fast against the device's: skip one sample this callback.
        if self.buf.len() > self.target * 2 + out.len() {
            self.buf.pop_front();
            self.dropped += 1;
        }
        for (i, slot) in out.iter_mut().enumerate() {
            match self.buf.pop_front() {
                Some(v) => *slot = v,
                None => {
                    out[i..].fill(0.0);
                    self.playing = false;
                    self.underruns += 1;
                    return;
                }
            }
        }
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn clear(&mut self) {
        self.buf.clear();
        self.playing = false;
    }
}

/// What the page reads back: whether it plays, where, at what rate.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub device: Option<String>,
    pub sample_rate: u32,
    pub buffered_ms: u32,
    pub underruns: u64,
    pub dropped: u64,
    pub error: Option<String>,
}

struct Shared {
    jitter: Mutex<Jitter>,
    status: Mutex<Status>,
}

enum Cmd {
    Start { device: Option<String>, reply: Sender<Result<Status, String>> },
    Stop,
}

struct Controller {
    tx: Mutex<Sender<Cmd>>,
    shared: Arc<Shared>,
}

static CONTROLLER: OnceLock<Controller> = OnceLock::new();

fn controller(app: &tauri::AppHandle) -> &'static Controller {
    CONTROLLER.get_or_init(|| {
        let shared = Arc::new(Shared {
            jitter: Mutex::new(Jitter::new(48_000)),
            status: Mutex::new(Status::default()),
        });
        let (tx, rx) = mpsc::channel::<Cmd>();
        let thread_shared = shared.clone();
        let app = app.clone();
        std::thread::Builder::new()
            .name("app-audio".into())
            .spawn(move || audio_thread(rx, thread_shared, app))
            .expect("spawn app-audio thread");
        Controller { tx: Mutex::new(tx), shared }
    })
}

/// Owns the cpal stream. Opens and closes it on command, and reopens it on
/// the Windows default device when the one in use goes away (headset
/// unplugged), reporting the change in the status.
fn audio_thread(rx: mpsc::Receiver<Cmd>, shared: Arc<Shared>, app: tauri::AppHandle) {
    let mut stream: Option<cpal::Stream> = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Cmd::Start { device, reply }) => {
                stream = None;
                let result = open(device.as_deref(), &shared).map(|(s, st)| {
                    stream = Some(s);
                    st
                });
                match &result {
                    Ok(st) => crate::rust_log(&app, format!(
                        "[AppAudio] Playing from lolproxchat.exe on \"{}\" at {} Hz",
                        st.device.as_deref().unwrap_or("?"), st.sample_rate)),
                    Err(e) => crate::rust_log(&app, format!("[AppAudio] Could not open output: {e}")),
                }
                let _ = reply.send(result);
            }
            Ok(Cmd::Stop) => {
                if stream.take().is_some() {
                    crate::rust_log(&app, "[AppAudio] Stopped");
                }
                let mut st = shared.status.lock().unwrap();
                *st = Status::default();
            }
            Err(RecvTimeoutError::Timeout) => {
                let lost = stream.is_some() && shared.status.lock().unwrap().error.is_some();
                if lost {
                    let err = shared.status.lock().unwrap().error.clone().unwrap_or_default();
                    crate::rust_log(&app, format!(
                        "[AppAudio] Output device failed ({err}); reopening on the Windows default"));
                    stream = None;
                    match open(None, &shared) {
                        Ok((s, st)) => {
                            stream = Some(s);
                            crate::rust_log(&app, format!(
                                "[AppAudio] Now on \"{}\" at {} Hz",
                                st.device.as_deref().unwrap_or("?"), st.sample_rate));
                        }
                        Err(e) => {
                            crate::rust_log(&app, format!("[AppAudio] Reopen failed: {e}"));
                            let mut st = shared.status.lock().unwrap();
                            st.running = false;
                            st.error = Some(e);
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// The output device called `name`, or the Windows default (also when `name`
/// is not there any more).
fn pick_device(host: &cpal::Host, name: Option<&str>) -> Result<cpal::Device, String> {
    if let Some(name) = name {
        if let Ok(mut devices) = host.output_devices() {
            if let Some(d) = devices.find(|d| d.name().map(|n| n == name).unwrap_or(false)) {
                return Ok(d);
            }
        }
    }
    host.default_output_device().ok_or_else(|| "no output device".to_string())
}

fn open(name: Option<&str>, shared: &Arc<Shared>) -> Result<(cpal::Stream, Status), String> {
    let host = cpal::default_host();
    let device = pick_device(&host, name)?;
    let device_name = device.name().unwrap_or_else(|_| "?".into());
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let sample_rate = supported.sample_rate().0;
    let config: cpal::StreamConfig = supported.config();
    {
        let mut j = shared.jitter.lock().unwrap();
        *j = Jitter::new(sample_rate);
    }
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build::<f32>(&device, &config, shared.clone()),
        cpal::SampleFormat::I16 => build::<i16>(&device, &config, shared.clone()),
        cpal::SampleFormat::U16 => build::<u16>(&device, &config, shared.clone()),
        cpal::SampleFormat::I32 => build::<i32>(&device, &config, shared.clone()),
        other => Err(format!("unsupported sample format {other:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    let status = Status {
        running: true,
        device: Some(device_name),
        sample_rate,
        ..Status::default()
    };
    *shared.status.lock().unwrap() = status.clone();
    Ok((stream, status))
}

fn build<T>(device: &cpal::Device, config: &cpal::StreamConfig, shared: Arc<Shared>) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + cpal::FromSample<f32>,
{
    let channels = config.channels.max(1) as usize;
    let err_shared = shared.clone();
    let mut mono: Vec<f32> = Vec::with_capacity(8192);
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                let frames = data.len() / channels;
                mono.resize(frames, 0.0);
                match shared.jitter.lock() {
                    Ok(mut j) => j.pull(&mut mono),
                    Err(_) => mono.fill(0.0),
                }
                // The same mono voice mix on every channel.
                for (frame, &v) in data.chunks_mut(channels).zip(mono.iter()) {
                    let s = T::from_sample(v.clamp(-1.0, 1.0));
                    for x in frame.iter_mut() {
                        *x = s;
                    }
                }
            },
            move |e| {
                if let Ok(mut st) = err_shared.status.lock() {
                    st.error = Some(e.to_string());
                }
            },
            None,
        )
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct DeviceList {
    devices: Vec<String>,
    default: Option<String>,
}

/// Output devices as lolproxchat.exe sees them, for the panel's picker.
#[tauri::command]
pub fn audio_out_devices() -> DeviceList {
    let host = cpal::default_host();
    let devices = host
        .output_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default();
    let default = host.default_output_device().and_then(|d| d.name().ok());
    DeviceList { devices, default }
}

/// Start (or restart) playing on `device` (None: the Windows default).
/// Returns the status, whose `sampleRate` the page must run its mix at.
#[tauri::command]
pub fn audio_out_start(app: tauri::AppHandle, device: Option<String>) -> Result<Status, String> {
    let c = controller(&app);
    let (reply, rx) = mpsc::channel();
    c.tx.lock().unwrap().send(Cmd::Start { device, reply }).map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "audio thread did not answer".to_string())?
}

/// One chunk of the voice mix: little-endian mono f32 samples, as the raw
/// request body.
#[tauri::command]
pub fn audio_out_push(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw body".into());
    };
    let samples: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    controller(&app).shared.jitter.lock().map_err(|e| e.to_string())?.push(&samples);
    Ok(())
}

#[tauri::command]
pub fn audio_out_stop(app: tauri::AppHandle) {
    let c = controller(&app);
    c.shared.jitter.lock().unwrap().clear();
    let _ = c.tx.lock().unwrap().send(Cmd::Stop);
}

#[tauri::command]
pub fn audio_out_status(app: tauri::AppHandle) -> Status {
    let c = controller(&app);
    let mut st = c.shared.status.lock().unwrap().clone();
    let j = c.shared.jitter.lock().unwrap();
    if st.sample_rate > 0 {
        st.buffered_ms = (j.len() as u64 * 1000 / st.sample_rate as u64) as u32;
    }
    st.underruns = j.underruns;
    st.dropped = j.dropped;
    st
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pull(j: &mut Jitter, n: usize) -> Vec<f32> {
        let mut out = vec![9.0; n];
        j.pull(&mut out);
        out
    }

    #[test]
    fn waits_for_the_target_before_playing() {
        let mut j = Jitter::new(48_000); // target 1920 samples
        j.push(&vec![0.5; 1000]);
        assert!(pull(&mut j, 480).iter().all(|&v| v == 0.0));
        j.push(&vec![0.5; 1000]);
        assert!(pull(&mut j, 480).iter().all(|&v| v == 0.5));
    }

    #[test]
    fn plays_in_order_without_loss() {
        let mut j = Jitter::new(48_000);
        let input: Vec<f32> = (0..4000).map(|i| i as f32).collect();
        j.push(&input);
        let mut got = Vec::new();
        for _ in 0..4 {
            got.extend(pull(&mut j, 480));
        }
        assert_eq!(got, input[..1920].to_vec());
    }

    #[test]
    fn running_dry_gives_silence_then_refills() {
        let mut j = Jitter::new(48_000);
        j.push(&vec![0.5; 2000]);
        let out = pull(&mut j, 2400);
        assert!(out[..2000].iter().all(|&v| v == 0.5));
        assert!(out[2000..].iter().all(|&v| v == 0.0));
        assert_eq!(j.underruns, 1);
        // Not playing again until the target is held once more.
        j.push(&vec![0.5; 1000]);
        assert!(pull(&mut j, 480).iter().all(|&v| v == 0.0));
    }

    #[test]
    fn a_stalled_page_catching_up_does_not_build_a_delay() {
        let mut j = Jitter::new(48_000);
        j.push(&vec![0.1; 48_000]); // a second at once
        assert!(j.len() <= 1920, "kept {}", j.len());
        assert!(j.dropped > 0);
    }

    /// Plays a quiet (0.01) 440 Hz tone for 3 s on the Windows default device
    /// through the real path (open → stream → jitter buffer), in 10 ms chunks
    /// like the page sends. Run by hand while watching the volume mixer (or
    /// its session meters): the sound must come from THIS process.
    /// `cargo test --bin lolproxchat plays_a_quiet_tone -- --ignored`
    #[test]
    #[ignore]
    fn plays_a_quiet_tone_from_this_process() {
        let shared = Arc::new(Shared {
            jitter: Mutex::new(Jitter::new(48_000)),
            status: Mutex::new(Status::default()),
        });
        let (stream, st) = open(None, &shared).expect("open default output");
        let rate = st.sample_rate as usize;
        let chunk = rate / 100;
        let mut phase = 0f32;
        let step = 440.0 * std::f32::consts::TAU / rate as f32;
        for _ in 0..300 {
            let samples: Vec<f32> = (0..chunk)
                .map(|_| {
                    phase = (phase + step) % std::f32::consts::TAU;
                    0.01 * phase.sin()
                })
                .collect();
            shared.jitter.lock().unwrap().push(&samples);
            std::thread::sleep(Duration::from_millis(10));
        }
        let j = shared.jitter.lock().unwrap();
        println!("device {:?} rate {} underruns {} dropped {}", st.device, st.sample_rate, j.underruns, j.dropped);
        drop(j);
        drop(stream);
    }

    #[test]
    fn a_slightly_fast_page_is_trimmed_a_sample_at_a_time() {
        let mut j = Jitter::new(48_000);
        j.push(&vec![0.1; 6000]); // well over twice the target
        let before = j.len();
        pull(&mut j, 480);
        assert_eq!(before - j.len(), 481);
    }
}
