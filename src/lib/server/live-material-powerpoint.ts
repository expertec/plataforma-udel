import JSZip from "jszip";

/** Validate the Office package before making it available to classroom clients. */
export async function validatePowerPointArchive(buffer: Buffer): Promise<number> {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  if (entries.length > 5000 || zip.file("ppt/vbaProject.bin")) throw new Error("Presentación no compatible.");
  let totalSize = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    // JSZip 3.10.1 retains the central-directory size without inflating each asset.
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new Error("Archivo PowerPoint inválido.");
    totalSize += size;
    if (totalSize > 100 * 1024 * 1024) throw new Error("La presentación descomprimida supera 100 MB. Reduce sus imágenes o divídela.");
  }
  const presentation = zip.file("ppt/presentation.xml");
  if (!zip.file("[Content_Types].xml") || !presentation || !zip.file("ppt/_rels/presentation.xml.rels")) {
    throw new Error("El archivo no es una presentación .pptx válida.");
  }
  const xml = await presentation.async("string");
  const count = (xml.match(/<(?:[\w]+:)?sldId\b/g) ?? []).length;
  const slides = entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name));
  if (!count || count > 300 || slides.length < count) throw new Error("La presentación debe contener entre 1 y 300 diapositivas.");
  return count;
}
