import { gzipSync } from "node:zlib";

/**
 * A tiny, dependency-free `.tar.gz` writer for the skills export download. Emits a
 * POSIX ustar archive (file entries only — extractors create parent dirs) and gzips it.
 * Names must be <= 100 bytes, which holds for our `<slug>/screenshots/<id>.png` paths.
 */
export interface TarFile {
    name: string;
    content: Buffer;
}

/** An octal field: `len-1` zero-padded octal digits followed by a NUL. */
function octalField(value: number, len: number): string {
    return `${value.toString(8).padStart(len - 1, "0")}\0`;
}

function tarHeader(name: string, size: number, mtimeSeconds: number): Buffer {
    if (Buffer.byteLength(name, "utf8") > 100) {
        throw new Error(`tar: entry name too long (>100 bytes): ${name}`);
    }
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100); // mode
    header.write("0000000\0", 108); // uid
    header.write("0000000\0", 116); // gid
    header.write(octalField(size, 12), 124);
    header.write(octalField(mtimeSeconds, 12), 136);
    header.write("        ", 148); // checksum placeholder: 8 spaces
    header.write("0", 156); // typeflag: regular file
    header.write("ustar\0", 257); // magic
    header.write("00", 263); // version

    let sum = 0;
    for (let i = 0; i < 512; i += 1) {
        sum += header[i] ?? 0;
    }
    // Checksum: 6 octal digits, NUL, then space.
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return header;
}

export function tarGzip(files: TarFile[], mtimeSeconds: number): Buffer {
    const chunks: Buffer[] = [];
    for (const file of files) {
        chunks.push(tarHeader(file.name, file.content.length, mtimeSeconds));
        chunks.push(file.content);
        const padding = (512 - (file.content.length % 512)) % 512;
        if (padding > 0) {
            chunks.push(Buffer.alloc(padding, 0));
        }
    }
    // Two zero blocks mark the end of the archive.
    chunks.push(Buffer.alloc(1024, 0));
    return gzipSync(Buffer.concat(chunks));
}
