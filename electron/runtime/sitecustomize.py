"""App-scoped Poppler fallback using the installed native PDFium renderer."""
import os
import shutil

if os.environ.get("CODEX_LOCAL_PDFIUM") == "1":
    import pdf2image
    import pypdfium2 as pdfium
    from pathlib import Path
    from uuid import uuid4

    _original_info = pdf2image.pdfinfo_from_path
    _original_convert = pdf2image.convert_from_path

    def _pdf_info(pdf_path, userpw=None, **options):
        if shutil.which("pdfinfo") or options.get("poppler_path"):
            return _original_info(pdf_path, userpw=userpw, **options)
        with pdfium.PdfDocument(str(pdf_path), password=userpw) as document:
            width, height = document[0].get_size()
            return {"Pages": len(document), "Page size": f"{width} x {height} pts", "Encrypted": "no"}

    def _pdf_convert(pdf_path, dpi=200, output_folder=None, first_page=None, last_page=None,
                     fmt="ppm", userpw=None, paths_only=False, output_file=None, **options):
        if shutil.which("pdftoppm") or options.get("poppler_path"):
            return _original_convert(pdf_path, dpi=dpi, output_folder=output_folder, first_page=first_page,
                                     last_page=last_page, fmt=fmt, userpw=userpw, paths_only=paths_only,
                                     output_file=output_file, **options)
        output = []
        prefix = output_file if isinstance(output_file, str) else uuid4().hex
        if output_folder:
            Path(output_folder).mkdir(parents=True, exist_ok=True)
        with pdfium.PdfDocument(str(pdf_path), password=userpw) as document:
            for index in range(max((first_page or 1) - 1, 0), min(last_page or len(document), len(document))):
                page = document[index]
                bitmap = page.render(scale=dpi / 72)
                image = bitmap.to_pil().copy()
                bitmap.close()
                page.close()
                if output_folder:
                    filename = Path(output_folder) / f"{prefix}-{index + 1}.{fmt}"
                    image.save(filename)
                    output.append(str(filename) if paths_only else image)
                elif paths_only:
                    raise ValueError("paths_only requires output_folder")
                else:
                    output.append(image)
        return output

    pdf2image.pdfinfo_from_path = _pdf_info
    pdf2image.convert_from_path = _pdf_convert
