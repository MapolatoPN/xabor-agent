// Adaptador Twilio retirado. WhatsApp solo se atiende por Meta y el agente nuevo.
import { Router } from 'express';
const router = Router();
router.post('/', (_req, res) => res.status(410).json({ codigo: 'WHATSAPP_TWILIO_RETIRADO' }));
export default router;
