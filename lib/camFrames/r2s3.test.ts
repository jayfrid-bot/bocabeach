import { describe, expect, it, vi } from "vitest";
import { listR2Prefix, parseListObjectsV2, signV4 } from "@/lib/camFrames/r2s3";

describe("signV4", () => {
  it("matches the AWS S3 documentation example (GET bucket with prefix and max-keys)", () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Example: GET Bucket (List Objects)".
    const out = signV4({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/",
      query: { "max-keys": "2", prefix: "J" },
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
      region: "us-east-1",
      service: "s3",
      extraHeaders: { "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    });
    expect(out.signedHeaders).toBe("host;x-amz-content-sha256;x-amz-date");
    expect(out.signature).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    expect(out.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });

  it("matches the AWS S3 documentation example (GET object with a Range header)", () => {
    const out = signV4({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      query: {},
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
      region: "us-east-1",
      service: "s3",
      extraHeaders: { range: "bytes=0-9", "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    });
    expect(out.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });
});

describe("parseListObjectsV2", () => {
  it("reads keys, truncation and the continuation token, unescaping XML entities", () => {
    const xml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken>' +
      "<Contents><Key>a/b/1.jpg</Key><Size>1</Size></Contents><Contents><Key>a/b/x&amp;y.jpg</Key></Contents></ListBucketResult>";
    expect(parseListObjectsV2(xml)).toEqual({ keys: ["a/b/1.jpg", "a/b/x&y.jpg"], truncated: true, nextToken: "tok&1" });
  });

  it("an empty listing has no keys and is not truncated", () => {
    expect(parseListObjectsV2("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")).toEqual({
      keys: [],
      truncated: false,
      nextToken: null,
    });
  });
});

describe("listR2Prefix", () => {
  const cfg = { accountId: "acct123", bucket: "my-bucket", accessKeyId: "AKID", secretAccessKey: "SECRET-VALUE", now: () => new Date("2026-10-11T14:20:00Z") };

  it("signs a path-style request, sends the prefix, and follows continuation tokens", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const pages = [
      "<R><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken><Contents><Key>s/c/1.jpg</Key></Contents></R>",
      "<R><IsTruncated>false</IsTruncated><Contents><Key>s/c/2.jpg</Key></Contents></R>",
    ];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> });
      return new Response(pages[calls.length - 1], { status: 200 });
    }) as unknown as typeof fetch;
    const keys = await listR2Prefix({ ...cfg, fetchImpl }, "s/c/");
    expect(keys).toEqual(["s/c/1.jpg", "s/c/2.jpg"]);
    expect(calls[0].url).toBe("https://acct123.r2.cloudflarestorage.com/my-bucket?list-type=2&max-keys=1000&prefix=s%2Fc%2F");
    expect(calls[1].url).toContain("continuation-token=t2");
    expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/20261011\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(calls[0].headers["x-amz-date"]).toBe("20261011T142000Z");
    expect(JSON.stringify(calls)).not.toContain("SECRET-VALUE");
  });

  it("throws on an HTTP error without echoing credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    await expect(listR2Prefix({ ...cfg, fetchImpl }, "s/c/")).rejects.toThrow(/HTTP 403/);
  });
});
