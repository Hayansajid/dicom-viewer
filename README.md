# DICOM Series Viewer — React + FastAPI + MySQL

Upload a set of DICOM (`.dcm`) slices that make up a scan, then scroll
horizontally through them (slider, filmstrip, mouse wheel, or arrow keys).
Handles both individual per-slice files and multi-frame files (e.g. a
tomosynthesis volume stored as one file with many frames), and both
uncompressed and compressed pixel data (JPEG 2000, JPEG-LS, JPEG Lossless,
RLE, Deflated).

```
dicom-viewer/
├── backend/     FastAPI API + MySQL access (SQLAlchemy) + decoding
└── frontend/    React (Vite) single-page app
```

## How it works

- **Upload**: the backend parses each file's DICOM header (`pydicom`) to
  pull out series/study metadata, transfer syntax, and frame count. A
  plain single-frame file becomes one row in the `slices` table; a
  multi-frame file becomes *one row per frame*, all pointing at the same
  stored file and distinguished by `frame_index`. The frontend never has
  to know which case it's looking at — it just sees a flat, ordered list
  of viewable images.
- **Decoding**: all pixel decompression happens server-side, in
  `backend/app/pixel_utils.py`, via `pydicom` + `pylibjpeg`/`gdcm`. This is
  the one place it happens, for every transfer syntax and both single- and
  multi-frame files — the browser never attempts to parse or decompress a
  DICOM file itself, which matters because browsers have no built-in
  support for JPEG 2000 or JPEG-LS at all.
- **Serving frames**: `GET /api/slices/{id}/pixels` returns one already-
  decoded frame as a raw binary buffer — float32 grayscale (already in
  real-world units, rescale slope/intercept applied) or uint8 RGB for
  color — with shape/kind in response headers. The frontend just reads
  that buffer and applies windowing on a canvas; no DICOM-parsing library
  is needed in the browser at all anymore.

## Prerequisites

- Python 3.10+
- Node.js 18+ (for the frontend only)
- A running MySQL 8.x server

## 1. Database

Run this once, from any MySQL client (command line, MySQL Workbench,
DBeaver, etc.):

```bash
mysql -u root -p < backend/db/schema.sql
```

This creates a `dicom_viewer` database with `series` and `slices` tables.
(The backend will also create these tables itself on first run if they
don't exist yet, so this step is a convenience, not a hard requirement.)

> **Upgrading from an earlier version of this project?** The `slices`
> table gained `frame_index` and `is_color` columns, and `series` gained
> `transfer_syntax_uid`. Since this is early-stage/test data, the simplest
> path is `DROP DATABASE dicom_viewer;` then re-run `schema.sql`. If you
> need to keep existing rows, there's an `ALTER TABLE` migration in a
> comment at the bottom of `schema.sql` instead.

## 2. Backend — opening it in VS Code

1. **Open the `backend/` folder** in VS Code (File → Open Folder…).
2. **Create a virtual environment**: open a terminal in VS Code
   (`` Ctrl+` ``) and run:
   ```bash
   python -m venv .venv
   ```
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
   ```
   This installs FastAPI, SQLAlchemy, `pydicom`, and the decompression
   plugins (`pylibjpeg-openjpeg` for JPEG 2000, `pylibjpeg-libjpeg` for
   JPEG Lossless/baseline, `pylibjpeg-rle` for RLE, `python-gdcm` as a
   broader fallback that also covers JPEG-LS). If this step fails with a
   Rust/`maturin` build error, see the note at the bottom.
4. **Set up your `.env`**:
   ```bash
   cp .env.example .env
   ```
   then fill in your MySQL username/password.
5. **Run it**: with `run.py` open, click the ▷ **Run** button in the top
   right of VS Code (or press `F5` if you've set up a launch config), or
   just run `python run.py` in the terminal. You should see Uvicorn start
   on `http://localhost:8000`.

   Interactive API docs are auto-generated at `http://localhost:8000/docs`
   — handy for testing uploads by hand without the frontend.

Endpoints:

| Method | Path                       | Purpose                                            |
|--------|----------------------------|-----------------------------------------------------|
| POST   | `/api/series`              | Upload one or more `.dcm` files (`files` field, multipart) |
| GET    | `/api/series`               | List uploaded series                                |
| GET    | `/api/series/:id`           | Series metadata + ordered list of frames/slices     |
| GET    | `/api/slices/:id/pixels`    | One decoded frame as a raw binary buffer (what the viewer uses) |
| GET    | `/api/slices/:id/raw`       | The original, untouched DICOM file (for download/inspection) |
| DELETE | `/api/series/:id`           | Delete a series, its slices, and its files          |

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
