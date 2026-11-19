"""Render real DOCX/PPTX/XLSX content with LibreOffice and PDFium."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import pypdfium2 as pdfium

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output_dir", required=True)
parser.add_argument("--scale", type=float, default=1)
args = parser.parse_args()
source = Path(args.input).resolve(strict=True)
destination = Path(args.output_dir).resolve()
destination.mkdir(parents=True, exist_ok=True)
soffice = os.environ.get("CODEX_LIBREOFFICE_PATH") or shutil.which("soffice.exe") or shutil.which("soffice")
if not soffice:
    raise RuntimeError("LibreOffice executable is not configured")
with tempfile.TemporaryDirectory(prefix="codex-office-") as staging:
    staging_path = Path(staging)
    profile = (staging_path / "profile").as_uri()
    result = subprocess.run([soffice, f"-env:UserInstallation={profile}", "--headless", "--convert-to", "pdf",
                             "--outdir", staging, str(source)], capture_output=True, text=True, timeout=120,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    pdf = staging_path / f"{source.stem}.pdf"
    if result.returncode or not pdf.is_file():
        raise RuntimeError(f"LibreOffice conversion failed: {result.stderr or result.stdout}")
    paths = []
    with pdfium.PdfDocument(pdf) as document:
        for index in range(len(document)):
            page = document[index]
            bitmap = page.render(scale=args.scale * 96 / 72)
            filename = destination / f"slide-{index + 1}.png"
            bitmap.to_pil().save(filename)
            bitmap.close()
            page.close()
            paths.append(str(filename))
print(json.dumps({"input": str(source), "outputDir": str(destination), "slideCount": len(paths), "paths": paths}))
