import test from "node:test";
import assert from "node:assert/strict";

import { selectLargestImageCandidates } from "../../src/collectors/instagram/image-candidates.js";

test("图片候选支持逗号后没有空格的地址列表", () => {
  const small = "https://cdn.example/photo.jpg?width=640";
  const large = "https://cdn.example/photo.jpg?width=1440";

  const selected = selectLargestImageCandidates([{
    src: small,
    currentSrc: small,
    srcset: `${small} 640w,${large} 1440w`,
    naturalWidth: 640,
    naturalHeight: 640,
  }]);

  assert.deepEqual(selected, [{ url: large, width: 1440, height: null }]);
});
