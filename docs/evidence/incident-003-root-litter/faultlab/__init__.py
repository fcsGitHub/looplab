"""FaultLab - reproducible fault-injection test environment.

Two backends:
  * ``docker``  - real containers (see deploy/docker-compose.yml, deploy/k8s/)
  * ``local``   - in-process deterministic simulation (runs anywhere, incl. sandboxes
                  without socket/subprocess privileges)

The local backend is the one used by ``verify.py`` for automated acceptance.
"""

__version__ = "1.0.0"
