// Filenames are display metadata only, never filesystem paths.
export function originalFilename(value: string): string | null {
  const basename = value.split(/[\\/]/).pop() ?? "";
  const clean = basename.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  const limited = Array.from(clean).slice(0, 255).join("");
  return limited && limited !== "." && limited !== ".." ? limited : null;
}

export function submissionDisplayName(filename: string | null, id: string, pageIndex: number, pageCount: number) {
  const name = filename ?? `Submission ${id}`;
  return pageCount > 1 ? `${name} — Page ${pageIndex + 1}` : name;
}
