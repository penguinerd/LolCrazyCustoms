import logging

from .app import ScrimBot
from .config import load_settings


def main() -> None:
    settings = load_settings()
    # logging.getLogger("discord").setLevel(logging.DEBUG)
    logging.basicConfig(
        level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    ScrimBot(settings).run(settings.token, log_handler=None)


if __name__ == "__main__":
    main()
