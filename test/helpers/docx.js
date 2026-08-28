import yazl from "yazl";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export async function createLinkDocxBuffer() {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:t>正文 https://www.instagram.com/body_user/</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>https://www.xiaohongshu.com/user/profile/table-user</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:hyperlink r:id="rId5"><w:r><w:t>可点击主页</w:t></w:r></w:hyperlink></w:p>
  </w:body>
</w:document>`;
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.instagram.com/clickable_user/" TargetMode="External"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://cdninstagram.com/not-a-profile.jpg" TargetMode="External"/>
</Relationships>`;
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(CONTENT_TYPES), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(PACKAGE_RELS), "_rels/.rels");
  zip.addBuffer(Buffer.from(document), "word/document.xml");
  zip.addBuffer(Buffer.from(documentRels), "word/_rels/document.xml.rels");
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.once("error", reject);
  });
  zip.end();
  return complete;
}
