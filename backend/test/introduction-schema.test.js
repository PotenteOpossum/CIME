import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyIntroduction,
  normalizeIntroduction,
  validateIntroductionImage,
} from "../../shared/introductionSchema.mjs";

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
test("topic pages preserve safe structured content and reject executable or remote images", () => {
  assert.deepEqual(
    normalizeIntroduction(emptyIntroduction()),
    emptyIntroduction(),
  );
  const page = normalizeIntroduction({
    enabled: true,
    title: "The proposal",
    blocks: [
      { id: "one", type: "heading", text: "Context", level: 3 },
      { id: "two", type: "paragraph", text: "<script>not executable</script>" },
      { id: "three", type: "list", text: "Trees\nShade", ordered: true },
      {
        id: "four",
        type: "image",
        src: pixel,
        alt: "A map",
        caption: "Study area",
        width: 75,
      },
    ],
  });
  assert.equal(page.blocks[1].text, "<script>not executable</script>");
  assert.equal(page.blocks[3].src, pixel);
  for (const source of [
    "https://tracker.invalid/image.png",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,PHNjcmlwdD4=",
  ]) {
    assert.throws(() => validateIntroductionImage(source), { status: 400 });
  }
  assert.throws(
    () =>
      normalizeIntroduction({
        ...page,
        blocks: [page.blocks[0], page.blocks[0]],
      }),
    /unique IDs/,
  );
  assert.throws(
    () =>
      normalizeIntroduction({
        ...page,
        blocks: [{ ...page.blocks[3], alt: "" }],
      }),
    /Describe each image/,
  );
  assert.throws(
    () => normalizeIntroduction({ ...page, blocks: [] }),
    /Add some text/,
  );
  assert.throws(
    () =>
      normalizeIntroduction({
        ...page,
        blocks: [{ id: "html", type: "html", text: "<iframe>" }],
      }),
    /Unsupported/,
  );
});
