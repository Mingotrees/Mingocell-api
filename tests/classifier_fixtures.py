"""Small-on-disk TIFF whose selected RGB page expands beyond transport budget."""
import io
import random
import sys
from PIL import Image


def large_lossless_page_tiff():
    image = Image.frombytes('RGB', (2000, 2000), random.Random(42).randbytes(12_000_000))
    data = io.BytesIO()
    image.save(data, format='TIFF', compression='jpeg', quality=35,
               save_all=True, append_images=[Image.new('RGB', (2000, 2000))])
    return data.getvalue()


if __name__ == '__main__':
    sys.stdout.buffer.write(large_lossless_page_tiff())
