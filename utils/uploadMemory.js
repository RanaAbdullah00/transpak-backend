/**
 * Release multer memory buffers after upload completes (success or failure).
 */
function releaseMulterFile(file) {
  if (file && Object.prototype.hasOwnProperty.call(file, "buffer")) {
    file.buffer = null;
  }
}

function releaseMulterFiles(files) {
  if (!files) return;
  if (Array.isArray(files)) {
    files.forEach(releaseMulterFile);
    return;
  }
  if (typeof files === "object") {
    Object.values(files).forEach((arr) => {
      if (Array.isArray(arr)) arr.forEach(releaseMulterFile);
    });
  }
}

module.exports = { releaseMulterFile, releaseMulterFiles };
