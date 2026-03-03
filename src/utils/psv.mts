type PsvRow = Record<string, string>;

export function parsePsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === "\"") {
      const next = line[index + 1];
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (character === "|" && !inQuotes) {
      fields.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  fields.push(current);
  return fields;
}

export async function streamPsvRows(
  path: string,
  onRow: (row: PsvRow) => void | Promise<void>,
  onProgress?: (bytesRead: number) => void,
): Promise<{ headers: string[]; rowCount: number }> {
  const decoder = new TextDecoder();
  const file = Bun.file(path);
  const stream = file.stream();

  let buffer = "";
  let headers: string[] | null = null;
  let rowCount = 0;
  let bytesRead = 0;

  for await (const chunk of stream) {
    bytesRead += chunk.byteLength;
    buffer += decoder.decode(chunk, { stream: true });
    onProgress?.(bytesRead);

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);

      if (!headers) {
        headers = parsePsvLine(rawLine);
        continue;
      }

      if (rawLine.length === 0) {
        continue;
      }

      const values = parsePsvLine(rawLine);
      const row: PsvRow = {};
      for (let index = 0; index < headers.length; index += 1) {
        row[headers[index]!] = values[index] ?? "";
      }

      rowCount += 1;
      await onRow(row);
    }
  }

  if (buffer.length > 0) {
    const rawLine = buffer.replace(/\r$/, "");
    if (!headers) {
      headers = parsePsvLine(rawLine);
    } else if (rawLine.length > 0) {
      const values = parsePsvLine(rawLine);
      const row: PsvRow = {};
      for (let index = 0; index < headers.length; index += 1) {
        row[headers[index]!] = values[index] ?? "";
      }
      rowCount += 1;
      await onRow(row);
    }
  }

  if (!headers) {
    throw new Error(`No PSV header row found in ${path}`);
  }

  return { headers, rowCount };
}
