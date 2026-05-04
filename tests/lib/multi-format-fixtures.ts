const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
	let c = n;
	for (let k = 0; k < 8; k += 1) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	CRC_TABLE[n] = c >>> 0;
}

export const PNG_BYTES = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
	'base64',
);

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: Array<{ name: string; data: Buffer | string }>): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf-8');
		const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf-8');
		const checksum = crc32(data);
		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0, 6);
		localHeader.writeUInt16LE(0, 8);
		localHeader.writeUInt16LE(0, 10);
		localHeader.writeUInt16LE(0x21, 12);
		localHeader.writeUInt32LE(checksum, 14);
		localHeader.writeUInt32LE(data.length, 18);
		localHeader.writeUInt32LE(data.length, 22);
		localHeader.writeUInt16LE(name.length, 26);
		localHeader.writeUInt16LE(0, 28);
		localParts.push(localHeader, name, data);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0, 8);
		centralHeader.writeUInt16LE(0, 10);
		centralHeader.writeUInt16LE(0, 12);
		centralHeader.writeUInt16LE(0x21, 14);
		centralHeader.writeUInt32LE(checksum, 16);
		centralHeader.writeUInt32LE(data.length, 20);
		centralHeader.writeUInt32LE(data.length, 24);
		centralHeader.writeUInt16LE(name.length, 28);
		centralHeader.writeUInt16LE(0, 30);
		centralHeader.writeUInt16LE(0, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE(0, 38);
		centralHeader.writeUInt32LE(offset, 42);
		centralParts.push(centralHeader, name);

		offset += localHeader.length + name.length + data.length;
	}

	const centralDirectory = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);

	return Buffer.concat([...localParts, centralDirectory, end]);
}

function xmlEscape(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function columnName(index: number): string {
	let name = '';
	let value = index + 1;
	while (value > 0) {
		const remainder = (value - 1) % 26;
		name = String.fromCharCode(65 + remainder) + name;
		value = Math.floor((value - 1) / 26);
	}
	return name;
}

function worksheetXml(rows: string[][]): string {
	const xmlRows = rows
		.map((row, rowIndex) => {
			const rowNumber = rowIndex + 1;
			const cells = row
				.map((value, columnIndex) => {
					const ref = `${columnName(columnIndex)}${rowNumber}`;
					return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
				})
				.join('');
			return `<row r="${rowNumber}">${cells}</row>`;
		})
		.join('');
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`;
}

export function createDocxBuffer(title: string, body: string): Buffer {
	const heading = xmlEscape(title);
	const paragraph = xmlEscape(body);
	return createZip([
		{
			name: '[Content_Types].xml',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
		},
		{
			name: '_rels/.rels',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
		},
		{
			name: 'word/_rels/document.xml.rels',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
		},
		{
			name: 'word/styles.xml',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>`,
		},
		{
			name: 'word/document.xml',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${heading}</w:t></w:r></w:p>
    <w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>
  </w:body>
</w:document>`,
		},
	]);
}

export function createXlsxBuffer(sheets: Array<{ name: string; rows: string[][] }>): Buffer {
	const sheetOverrides = sheets
		.map(
			(_sheet, index) =>
				`<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
		)
		.join('');
	const workbookSheets = sheets
		.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
		.join('');
	const workbookRels = sheets
		.map(
			(_sheet, index) =>
				`<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
		)
		.join('');
	return createZip([
		{
			name: '[Content_Types].xml',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheetOverrides}
</Types>`,
		},
		{
			name: '_rels/.rels',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
		},
		{
			name: 'xl/workbook.xml',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`,
		},
		{
			name: 'xl/_rels/workbook.xml.rels',
			data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}</Relationships>`,
		},
		...sheets.map((sheet, index) => ({
			name: `xl/worksheets/sheet${index + 1}.xml`,
			data: worksheetXml(sheet.rows),
		})),
	]);
}

export function createEmlContent(input: { messageId: string; subject: string; body: string }): string {
	return [
		'From: Golden Sender <sender@example.com>',
		'To: Golden Recipient <recipient@example.com>',
		'Date: Fri, 01 May 2026 10:00:00 +0000',
		`Message-ID: <${input.messageId}>`,
		`Subject: ${input.subject}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset="utf-8"',
		'',
		input.body,
		'',
	].join('\r\n');
}
