"""Pixel contract against Pillow and, when requested, the installed canonical loader."""
import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from PIL import Image, ImageOps
from classifier_fixtures import large_lossless_page_tiff

HELPER = Path(__file__).resolve().parents[1] / 'scripts/extract-classifier-page.py'


class InputTests(unittest.TestCase):
    def test_valid_tiff_lossless_expansion_has_permanent_size_failure(self):
        payload = large_lossless_page_tiff()
        self.assertLessEqual(len(payload), 5 * 1024 * 1024)
        result = self.extract(payload, 0)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(result.stdout, b'')

    def extract(self, payload, index):
        return subprocess.run([sys.executable, str(HELPER), str(index)], input=payload,
                              capture_output=True, timeout=30)

    def test_distinct_frames_and_modes(self):
        for mode in ('RGB', 'RGBA', 'P', 'I;16', 'CMYK'):
            with self.subTest(mode=mode):
                first = Image.new(mode, (3, 5), 0)
                second = Image.new(mode, (3, 5), 42)
                if mode == 'P':
                    second.putpalette([x for i in range(256) for x in (i, 255-i, i//2)])
                buf = io.BytesIO()
                first.save(buf, format='TIFF', save_all=True, append_images=[second])
                result = self.extract(buf.getvalue(), 1)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stderr)['extractionVersion'], 'pillow-page-rgb-v1')
                with Image.open(io.BytesIO(buf.getvalue())) as source:
                    source.seek(1)
                    expected = ImageOps.exif_transpose(source).convert('RGB')
                    with Image.open(io.BytesIO(result.stdout)) as actual:
                        self.assertEqual(actual.mode, 'RGB')
                        self.assertEqual(actual.tobytes(), expected.tobytes())
                        self.assertEqual(actual.size, expected.size)
                    if os.environ.get('REQUIRE_CANONICAL_LOADER') == '1':
                        from myeloid.data.loader import load_rgb_image_bytes
                        self.assertEqual(load_rgb_image_bytes(result.stdout).tobytes(), expected.tobytes())

    def test_orientation_not_applied_twice(self):
        image = Image.new('RGB', (2, 3))
        image.putdata([(255,0,0),(0,255,0),(0,0,255),(255,255,0),(0,255,255),(255,0,255)])
        data = io.BytesIO()
        image.save(data, format='TIFF', save_all=True, append_images=[image], tiffinfo={274:6})
        result = self.extract(data.getvalue(), 1)
        self.assertEqual(result.returncode, 0, result.stderr)
        with Image.open(io.BytesIO(data.getvalue())) as source:
            source.seek(1)
            expected = ImageOps.exif_transpose(source).convert('RGB')
            with Image.open(io.BytesIO(result.stdout)) as actual:
                self.assertEqual(actual.size, expected.size)
                self.assertEqual(actual.tobytes(), expected.tobytes())

    def test_corrupt_out_of_range_and_oversized(self):
        self.assertNotEqual(self.extract(b'bad image', 0).returncode, 0)
        buf = io.BytesIO()
        Image.new('RGB',(2,2)).save(buf,format='TIFF')
        self.assertNotEqual(self.extract(buf.getvalue(), 3).returncode, 0)
        buf = io.BytesIO()
        Image.new('L',(2001,2000)).save(buf,format='TIFF',compression='tiff_lzw')
        self.assertNotEqual(self.extract(buf.getvalue(), 0).returncode, 0)


if __name__ == '__main__':
    unittest.main()
