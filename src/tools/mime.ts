// Extension → MIME table, mirroring the CloudSee storage service's own
// `lib/utils/ExtensionUtil.js`.
//
// WHY THIS HAS TO EXIST: `/storage/upload/url` does NOT sign the content type the
// caller asks for. The service recomputes it from the file name and signs the
// pre-signed PUT with *that* value (StorageService.generateSignedUrlPutFile), while
// returning only the URL string — so the caller is never told what was signed. Send a
// different `Content-Type` on the PUT and S3 rejects it with 403 SignatureDoesNotMatch,
// because Content-Type is a signed header for a pre-signed putObject.
//
// So we derive the type exactly the way the server does and use that single value for
// both the presign request and the PUT header. This is what the web app already does
// (csd-frontend StorageContext.getUploadUrl/uploadS3 both call getS3ContentType), and
// it is why uploads from the browser work.
//
// The table is committed as contract/mime.snapshot.json and asserted by the
// contract-drift test, so it cannot silently diverge from the service.
// Regenerate with: MIME_SOURCE_PATH=<…>/ExtensionUtil.js npm run sync:contract

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  // Images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  tif: "image/tiff",
  bmp: "image/bmp",
  ico: "image/x-icon",
  heic: "image/heic",
  heif: "image/heif",

  // Documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",

  // Archives
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",

  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",

  // Video
  mp4: "video/mp4",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  wmv: "video/x-ms-wmv",
  mkv: "video/x-matroska",
  flv: "video/x-flv",

  // Web
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  json: "application/json",
  xml: "application/xml",

  // Fonts
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",

  // Programming/Code
  py: "text/x-python",
  java: "text/x-java",
  c: "text/x-c",
  cpp: "text/x-c++",
  cs: "text/x-csharp",
  php: "application/x-php",
  rb: "text/x-ruby",
  go: "text/x-go",
  ts: "application/typescript",
  sh: "application/x-sh",
  sql: "application/sql",

  // CAD and 3D
  dwg: "image/vnd.dwg",
  dxf: "image/vnd.dxf",
  stl: "model/stl",
  obj: "model/obj",

  // Database
  mdb: "application/vnd.ms-access",
  accdb: "application/vnd.ms-access",
  sqlite: "application/x-sqlite3",

  // Email
  eml: "message/rfc822",
  msg: "application/vnd.ms-outlook",

  // Miscellaneous
  log: "text/plain",
  bin: DEFAULT_CONTENT_TYPE,
  exe: "application/vnd.microsoft.portable-executable",
  dll: "application/vnd.microsoft.portable-executable",
  iso: "application/x-iso9660-image",
});

/**
 * The content type the storage service will sign this file name with — the mirror of
 * its `getContentType()`: last dot-segment, lower-cased, falling back to
 * application/octet-stream for anything not in the table (including names with no dot).
 */
export function mimeForFileName(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? DEFAULT_CONTENT_TYPE;
}
