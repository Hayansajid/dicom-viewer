# AI-Enhanced DICOM Series Viewer — React + FastAPI + PyTorch + MySQL

A full-stack, web-based medical imaging viewer designed to display DICOM CT scans and run an AI model to detect acute ischemic stroke.

Upload a set of DICOM (`.dcm`) slices that make up a scan, scroll horizontally through them, and toggle an AI overlay that highlights the stroke core (red) and penumbra (yellow). The backend handles the heavy lifting, decoding compressed medical images and running a deep learning segmentation model.

```
dicom-viewer/
├── backend/ FastAPI API + MySQL (SQLAlchemy) + PyTorch AI inference
└── frontend/ React (Vite) single-page app + HTML Canvas overlays
```

## How it works

- **Upload**: the backend parses each file's DICOM header (`pydicom`) to pull out series/study metadata and frame count. A plain single-frame file becomes one row in the `slices` table; a multi-frame file becomes _one row per frame_.
- **Decoding**: all pixel decompression happens server-side via `pydicom` + `pylibjpeg`/`gdcm` (handling JPEG 2000, JPEG-LS, RLE, etc.). The browser never attempts to parse or decompress a DICOM file itself.
- **Serving frames**: `GET /api/slices/{id}/pixels` returns one already-decoded frame as a raw binary buffer. The frontend reads that buffer and applies custom window/level controls on an HTML canvas.
- **AI Inference**: When the user clicks "Show AI Overlay", the frontend requests `GET /api/slices/{id}/stroke-overlay`. The backend loads an **FPN with an EfficientNet-B3 backbone** (trained via PyTorch on the CPAISD dataset) to segment the image into 3 classes: Background, Core, and Penumbra.
- **Overlay Rendering**: The backend extracts the boundaries of the core and penumbra (via OpenCV) and sends them as lightweight JSON polygons. The frontend renders these as semi-transparent red and yellow overlays.

## Prerequisites

- Python 3.10+
- Node.js 18+ (for the frontend only)
- A running MySQL 8.x server

## 1. Database

Run this once, from any MySQL client:

````bash
mysql -u root -p < backend/db/schema.sql

This creates a dicom_viewer database with series and slices tables.

## 2. Backend — opening it in VS Code

python -m venv .venv
.venv\Scripts\activate  # Windows
# source .venv/bin/activate  # macOS/Linux
   '''
   VS Code should prompt "We noticed a new environment has been created —
   do you want to select it for the workspace?" — click **Yes**. If it
   doesn't prompt, open the Command Palette (`Ctrl+Shift+P`) → **Python:
   Select Interpreter** → choose the one inside `.venv`.
3. **Activate it and install dependencies** in the VS Code terminal
   (it should auto-activate once selected as the interpreter; if the
   prompt doesn't show `(.venv)`, activate manually):
   ```bash
   # Windows
   .venv\Scripts\activate
   # macOS/Linux
   source .venv/bin/activate

   pip install -r requirements.txt
````

This installs FastAPI, SQLAlchemy, `pydicom`, and the decompression
plugins (`pylibjpeg-openjpeg` for JPEG 2000, `pylibjpeg-libjpeg` for
JPEG Lossless/baseline, `pylibjpeg-rle` for RLE, `python-gdcm` as a
broader fallback that also covers JPEG-LS). If this step fails with a
Rust/`maturin` build error, see the note at the bottom. 4. **Set up your `.env`**:

```bash
cp .env.example .env
```

then fill in your MySQL username/password. 5. **Run it**: with `run.py` open, click the ▷ **Run** button in the top
right of VS Code (or press `F5` if you've set up a launch config), or
just run `python run.py` in the terminal. You should see Uvicorn start
on `http://localhost:8000`.

Interactive API docs are auto-generated at `http://localhost:8000/docs`
— handy for testing uploads by hand without the frontend.

Endpoints:

| Method | Path                     | Purpose                                                         |
| ------ | ------------------------ | --------------------------------------------------------------- |
| POST   | `/api/series`            | Upload one or more `.dcm` files (`files` field, multipart)      |
| GET    | `/api/series`            | List uploaded series                                            |
| GET    | `/api/series/:id`        | Series metadata + ordered list of frames/slices                 |
| GET    | `/api/slices/:id/pixels` | One decoded frame as a raw binary buffer (what the viewer uses) |
| GET    | `/api/slices/:id/raw`    | The original, untouched DICOM file (for download/inspection)    |
| DELETE | `/api/series/:id`        | Delete a series, its slices, and its files                      |

## 3. Frontend

Unchanged regardless of backend — it just talks to whatever
`VITE_API_URL` points at.

```bash
cd frontend
cp .env.example .env    # already set to http://localhost:8000
npm install
npm run dev              # http://localhost:5173
```

You can run this from a second VS Code terminal tab, or a separate
terminal — either is fine.

## Notes / limitations

- Covers uncompressed pixel data plus JPEG 2000 (lossy and lossless),
  JPEG-LS, JPEG Lossless/baseline, RLE Lossless, and Deflated Explicit VR
  — both single-frame files and multi-frame files with any number of
  frames. If a file uses a transfer syntax none of the installed plugins
  support, `/pixels` returns a 422 with the underlying error message
  rather than a blank image.
- The frontend fetches and decodes every frame in a series up front so
  scrolling is instant; for very large series (hundreds of slices/frames)
  you'll want to switch this to fetch-on-demand around the current index.
- There's no authentication — add it before exposing this beyond your
  own machine, especially since it's handling medical imaging data.
- File storage is local disk; swap the `UPLOAD_DIR` handling in
  `backend/app/main.py` for S3/GCS if you need it to run across
  multiple machines.

### If `pip install -r requirements.txt` fails with a Rust/`maturin` error

This happens when pip can't find a prebuilt wheel for `pydantic-core` (a
FastAPI dependency) for your exact Python/OS/architecture and tries to
compile it from source. Install Rust from [rustup.rs](https://rustup.rs),
restart your terminal, and retry — no code changes needed. This is
unrelated to the DICOM decompression libraries above.
