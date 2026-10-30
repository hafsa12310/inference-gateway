import logging
import time

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("autoscaler")

if __name__ == "__main__":
    log.info("autoscaler started")
    while True:
        log.info("tick: nothing to do yet")
        time.sleep(30)
