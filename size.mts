import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
const c = new S3Client({ region:process.env.S3_REGION!, endpoint:process.env.S3_ENDPOINT!, forcePathStyle:true,
  credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID!,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY!} });

for (const mb of [1, 4, 8, 10, 16, 20]) {
  const bytes = new Uint8Array(mb * 1024 * 1024).fill(1);
  const key = `probe/size-${mb}mb.mp4`;
  try {
    await c.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key, Body: bytes, ContentType: 'video/mp4' }));
    console.log(`  ${String(mb).padStart(3)}MB -> OK`);
    await c.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
  } catch (e) {
    const msg = String((e as Error).message);
    console.log(`  ${String(mb).padStart(3)}MB -> FAIL: ${msg.slice(0,110)}`);
    if (/too big/i.test(msg)) { console.log(`       ^ ceiling reached at ${mb}MB`); break; }
  }
}
process.exit(0);
