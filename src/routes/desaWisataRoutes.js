const express = require("express");
const { addDesaWisata, getAllDesaWisata, getDesaWisataById, updateDesaWisata, deleteDesaWisata, getDesaByUserEmail, getAllDesaWisataWithDetails, getDesaWisataBySlug } = require("../handlers/desaWisataHandler");
const { authenticateToken, checkRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/desa-wisata", addDesaWisata);
router.get("/desa-wisata", getAllDesaWisata);
router.get("/desa-wisata/details", getAllDesaWisataWithDetails);
router.get("/desa-wisata/:kd_desa", getDesaWisataById);

router.put("/desa-wisata/:kd_desa", authenticateToken, checkRole("pengelola"), updateDesaWisata);

router.delete("/desa-wisata/:kd_desa", authenticateToken, checkRole("pengelola"), deleteDesaWisata);

router.get("/desa-wisata/email/:email", getDesaByUserEmail);

router.get("/desa-wisata/slug/:slug", getDesaWisataBySlug);

module.exports = router;
