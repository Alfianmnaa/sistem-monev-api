const express = require("express");
const { authenticateToken, checkRole } = require("../middleware/authMiddleware");
const {
  addDeskripsiWisata,
  getAllDeskripsiWisata,
  getDeskripsiWisataByKdDesa,
  updateDeskripsiWisata,
  deleteDeskripsiWisata,
  upload,
  handleUploadErrors,
  patchDeskripsiWisata,
  patchRemoveItemDeskripsiWisata,
  uploadImageToGCS,
  getRandomAtraksiWisata,
} = require("../handlers/deskripsiWisataHandler");
const { checkOwnership } = require("../middleware/checkOwnership");
const router = express.Router();

// Define the fields and their limits for file uploads
const imageFields = [
  { name: "atraksi", maxCount: 10 },
  { name: "penginapan", maxCount: 10 },
  { name: "paket_wisata", maxCount: 10 },
  { name: "suvenir", maxCount: 10 },
];

// GET all deskripsi wisata
router.get("/deskripsi-wisata", getAllDeskripsiWisata);

// GET deskripsi wisata by kd_desa
router.get("/deskripsi-wisata/:kd_desa", getDeskripsiWisataByKdDesa);

router.get("/atraksi-wisata", getRandomAtraksiWisata);

// POST create deskripsi wisata with multiple image uploads
router.post(
  "/deskripsi-wisata",
  authenticateToken,
  checkRole("pengelola"),
  handleUploadErrors, // Use error handler from handler
  upload.fields(imageFields), // Use upload from handler
  addDeskripsiWisata
);

// PUT update deskripsi wisata with multiple image uploads
router.put(
  "/deskripsi-wisata/:kd_desa",
  authenticateToken,
  checkRole("pengelola"),
  handleUploadErrors, // Use error handler from handler
  upload.fields(imageFields), // Use upload from handler
  updateDeskripsiWisata,
  checkOwnership
);

// DELETE deskripsi wisata
router.delete("/deskripsi-wisata/:kd_desa", authenticateToken, checkRole("pengelola"), deleteDeskripsiWisata, checkOwnership);

// Route
router.patch(
  "/deskripsi-wisata/:kd_desa",
  upload.fields([
    { name: "atraksi", maxCount: 25 },
    { name: "penginapan", maxCount: 25 },
    { name: "paket_wisata", maxCount: 25 },
    { name: "suvenir", maxCount: 25 },
  ]),
  handleUploadErrors,
  patchDeskripsiWisata
);

router.patch("/deskripsi-wisata/:kd_desa/remove-item", patchRemoveItemDeskripsiWisata);

router.post("/upload/gambar", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ status: "fail", message: "No file uploaded" });
    }

    // Upload ke GCS
    const gcsUrl = await uploadImageToGCS(req.file); // Implementasi fungsi uploadToGCS

    res.status(200).json({
      status: "success",
      url: gcsUrl,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

module.exports = router;
