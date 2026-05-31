/**
 * Profile completeness — 100% only when CNIC docs uploaded AND admin verified.
 * Does not alter DB schema; used when reading/writing is_profile_complete.
 */
function profileDocsUploaded(user) {
  if (!user) return false;
  const cnicImage = user.cnicImage || user.cnic_image;
  const cnicImageBack = user.cnicImageBack || user.cnic_image_back;
  return Boolean(cnicImage && cnicImageBack);
}

function computeProfileComplete(user) {
  return profileDocsUploaded(user) && Boolean(user?.verified);
}

module.exports = {
  profileDocsUploaded,
  computeProfileComplete
};
