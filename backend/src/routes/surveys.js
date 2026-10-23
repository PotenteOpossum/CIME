import { createRouter } from "../middleware/router.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";
import {
  getParticipantSurveyStatus,
  getSurveyDefinitions,
  saveSurveyDefinitions,
  submitSurvey,
  surveyExport,
  surveyResponseSummaries,
  surveysLocked,
} from "../services/surveyService.js";

export const surveyAdminRoutes = createRouter();
surveyAdminRoutes.use(authMiddleware, adminMiddleware);
surveyAdminRoutes.get("/", (_req, res) =>
  res.json({
    surveys: getSurveyDefinitions(),
    locked: surveysLocked(),
    responses: surveyResponseSummaries(),
  }),
);
surveyAdminRoutes.put("/", (req, res) =>
  res.json({ surveys: saveSurveyDefinitions(req.body), locked: false }),
);
surveyAdminRoutes.get("/export", (_req, res) => {
  res.set(
    "Content-Disposition",
    'attachment; filename="cime-survey-responses.json"',
  );
  res.json(surveyExport());
});

export const surveyParticipantRoutes = createRouter();
surveyParticipantRoutes.use(authMiddleware);
surveyParticipantRoutes.get("/", (req, res) =>
  res.json(getParticipantSurveyStatus(req.user.id)),
);
surveyParticipantRoutes.post("/:stage/responses", (req, res) =>
  res
    .status(201)
    .json(submitSurvey(req.params.stage, req.user.id, req.body?.answers)),
);

function surveyError(error, _req, res, next) {
  if (![400, 403, 404, 409].includes(error.status)) return next(error);
  return res.status(error.status).json({ error: error.message });
}
surveyAdminRoutes.use(surveyError);
surveyParticipantRoutes.use(surveyError);
