"""
Run this file directly in VS Code (open it and click the Run button, or
press F5) or from a terminal with `python run.py`. It starts the API on
http://localhost:8000 with auto-reload enabled.
"""
import os
from pathlib import Path
import uvicorn
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).resolve().parent / ".env")

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        reload=True,
    )
