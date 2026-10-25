import assert from "node:assert/strict";
import test from "node:test";
import { originalFilename, submissionDisplayName } from "../dist/images/labels.js";

test("display filenames preserve readable names without paths or control characters", () => {
  assert.equal(originalFilename("Patient42_slide3.tif"), "Patient42_slide3.tif");
  assert.equal(originalFilename("C:\\slides\\Patient42_slide3.tif"), "Patient42_slide3.tif");
  assert.equal(originalFilename("../../slides/Patient42_slide3.tif"), "Patient42_slide3.tif");
  assert.equal(originalFilename("  slide\u0000\r\n\u202e.tif  "), "slide.tif");
  assert.equal(originalFilename("細胞 🧪.png"), "細胞 🧪.png");
  assert.equal(Array.from(originalFilename("🧪".repeat(300))).length, 255);
  for (const name of ["", "   ", ".", "..", "folder/"]) assert.equal(originalFilename(name), null);
});

test("review labels distinguish TIFF pages and provide legacy fallbacks", () => {
  assert.equal(submissionDisplayName("slide.tif", "id", 0, 1), "slide.tif");
  assert.equal(submissionDisplayName("slide.tif", "id", 1, 3), "slide.tif — Page 2");
  assert.equal(submissionDisplayName(null, "id", 0, 1), "Submission id");
  assert.equal(submissionDisplayName(null, "id", 0, 3), "Submission id — Page 1");
});
