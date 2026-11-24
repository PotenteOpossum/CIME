export const MAX_INTRODUCTION_BYTES = 6 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const emptyIntroduction = () => ({
  enabled: false,
  title: "About this topic",
  blocks: [],
});

const fail = (message) => {
  throw Object.assign(new Error(message), { status: 400 });
};
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
function text(value, label, limit) {
  if (typeof value !== "string" || value.length > limit)
    fail(
      `${label} must be text of at most ${limit.toLocaleString()} characters.`,
    );
  return value.trim();
}

// Images travel with the document: no third-party requests or executable SVG/HTML.
export function validateIntroductionImage(src) {
  if (
    typeof src !== "string" ||
    src.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64
  )
    fail("Use images of at most 1 MB after resizing.");
  const match = src.match(
    /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  if (!match || match[2].length % 4 !== 0)
    fail("Upload a PNG, JPEG, WebP, or GIF image.");
  const bytes =
    (match[2].length * 3) / 4 -
    (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES)
    fail("Use images of at most 1 MB after resizing.");
  const header = atob(match[2].slice(0, 32));
  const valid = {
    png: header.startsWith("\x89PNG\r\n\x1a\n"),
    jpeg: header.startsWith("\xff\xd8\xff"),
    webp: header.startsWith("RIFF") && header.slice(8, 12) === "WEBP",
    gif: header.startsWith("GIF87a") || header.startsWith("GIF89a"),
  }[match[1]];
  if (!valid) fail("The uploaded file is not a supported image.");
  return src;
}

export function normalizeIntroduction(input) {
  if (
    !object(input) ||
    typeof input.enabled !== "boolean" ||
    !Array.isArray(input.blocks)
  )
    fail(
      "Provide a topic description with an enabled setting and content blocks.",
    );
  if (JSON.stringify(input).length > MAX_INTRODUCTION_BYTES)
    fail("The topic description is too large. Use fewer or smaller images.");
  const title = text(input.title, "Page title", 200);
  if (input.enabled && !title) fail("Give the topic description a title.");
  if (input.blocks.length > 50) fail("Use at most 50 content blocks.");
  const ids = new Set();
  let textSize = 0,
    images = 0;
  const blocks = input.blocks.map((block) => {
    if (
      !object(block) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(block.id || "") ||
      ids.has(block.id)
    )
      fail("Content blocks need unique IDs.");
    ids.add(block.id);
    if (!["heading", "paragraph", "list", "image"].includes(block.type))
      fail("Unsupported content block.");
    if (block.type === "image") {
      if (++images > 8) fail("Use at most eight images.");
      const alt = text(block.alt, "Image description", 500);
      if (!alt)
        fail("Describe each image for participants using screen readers.");
      return {
        id: block.id,
        type: "image",
        src: validateIntroductionImage(block.src),
        alt,
        caption: text(block.caption, "Image caption", 1000),
        width: [50, 75, 100].includes(block.width) ? block.width : 100,
      };
    }
    const content = text(block.text, "Block content", 10000);
    textSize += content.length;
    if (textSize > 40000)
      fail("Use at most 40,000 characters across text blocks.");
    return {
      id: block.id,
      type: block.type,
      text: content,
      ...(block.type === "heading" ? { level: block.level === 3 ? 3 : 2 } : {}),
      ...(block.type === "list" ? { ordered: block.ordered === true } : {}),
    };
  });
  if (
    input.enabled &&
    !blocks.some((block) => block.type === "image" || block.text)
  )
    fail("Add some text or an image before enabling the topic description.");
  return { enabled: input.enabled, title, blocks };
}
