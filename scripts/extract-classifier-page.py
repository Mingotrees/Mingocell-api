"""Extract one TIFF frame under the deployed canonical Pillow RGB policy.

stdin is immutable original bytes; stdout is metadata-free RGB PNG. Never loads
models. Exit codes: 2 invalid input, 3 output too large, 4 unavailable decoder.
"""
import io
import json
import sys
import warnings


def main():
    try:
        import PIL
        from PIL import Image, ImageOps
    except ImportError:
        return 4
    try:
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        payload = sys.stdin.buffer.read(5 * 1024 * 1024 + 1)
        if not payload or len(payload) > 5 * 1024 * 1024:
            return 2
        index = int(sys.argv[1])
        if not 0 <= index < 20:
            return 2
        with Image.open(io.BytesIO(payload)) as image:
            if image.format != 'TIFF' or getattr(image, 'n_frames', 1) > 20:
                return 2
            image.seek(index)
            if image.width * image.height > 4_000_000:
                return 2
            rgb = ImageOps.exif_transpose(image).convert('RGB')
            # A fresh image carries no EXIF orientation/ICC/other source metadata.
            clean = Image.frombytes('RGB', rgb.size, rgb.tobytes())
            output = io.BytesIO()
            clean.save(output, format='PNG')
        if output.tell() > 9 * 1024 * 1024:
            return 3
        sys.stdout.buffer.write(output.getvalue())
        sys.stderr.write(json.dumps({'pillowVersion': PIL.__version__,
                                    'extractionVersion': 'pillow-page-rgb-v1'}))
        return 0
    except Exception:
        return 2


if __name__ == '__main__':
    sys.exit(main())
