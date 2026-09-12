/** Supported input size; raw audio goes directly to private storage. */
export const MAX_AUDIO_UPLOAD_BYTES = 200 * 1024 * 1024;
/** Input plus lossless output must fit the function's temporary disk. */
export const MAX_VERIFIED_AUDIO_BYTES = 256 * 1024 * 1024;

export type AudioUploadTransfer = {
  endpoint: string;
  bucketName: "lecture-audio";
  objectName: string;
  token: string;
  contentType: string;
};
