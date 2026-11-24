import { createRouter } from "../middleware/router.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";
import {
  getIntroduction,
  introductionLocked,
  saveIntroduction,
  participantIntroduction,
  acknowledgeIntroduction,
} from "../services/introductionService.js";

export const introductionAdminRoutes = createRouter();
introductionAdminRoutes.use(authMiddleware, adminMiddleware);
introductionAdminRoutes.get("/", (_req, res) =>
  res.json({ introduction: getIntroduction(), locked: introductionLocked() }),
);
introductionAdminRoutes.put("/", (req, res) =>
  res.json({ introduction: saveIntroduction(req.body), locked: false }),
);

export const introductionParticipantRoutes = createRouter();
introductionParticipantRoutes.use(authMiddleware);
introductionParticipantRoutes.get("/", (req, res) =>
  res.json(participantIntroduction(req.user.id, true)),
);
introductionParticipantRoutes.post("/continue", (req, res) =>
  res.json(acknowledgeIntroduction(req.user.id, req.body.version)),
);
