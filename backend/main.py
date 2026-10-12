"""Starts the Greenova backend at http://localhost:8000.

From the backend folder:
    python main.py

It uses the backend's .venv by itself (no need to activate it first), and restarts when you
edit the code. Stop it with Ctrl+C.
"""
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent


def venv_python() -> Path | None:
    for candidate in (BACKEND / ".venv" / "Scripts" / "python.exe",   # Windows
                      BACKEND / ".venv" / "bin" / "python"):          # Raspberry Pi, macOS, Linux
        if candidate.exists():
            return candidate
    return None


def main() -> int:
    os.chdir(BACKEND)                      # the database and the "app" folder are found from here
    sys.path.insert(0, str(BACKEND))
    try:
        import fastapi  # noqa: F401
        import uvicorn
    except ImportError:
        python = venv_python()
        if python and Path(sys.executable).resolve() != python.resolve():
            # This Python doesn't have the packages, but the .venv does: run there instead.
            return subprocess.call([str(python), str(BACKEND / "main.py"), *sys.argv[1:]])
        print("The backend packages aren't installed. In the backend folder, run once:\n"
              "    python -m venv .venv\n"
              "    .venv\\Scripts\\python.exe -m pip install -r requirements.txt   (Windows)\n"
              "Then run  python main.py  again.")
        return 1

    print("Greenova backend: http://localhost:8000   (API docs: http://localhost:8000/docs)")
    print("Leave this window open. Press Ctrl+C to stop.")
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True, reload_dirs=[str(BACKEND / "app")])
    return 0


if __name__ == "__main__":
    sys.exit(main())
