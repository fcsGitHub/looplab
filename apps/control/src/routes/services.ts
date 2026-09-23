// Service registry shared by routes and the entrypoint.
import type { Db } from "../db.js";
import type { Config } from "../config.js";
import type { AuthService } from "../auth.js";
import type { GoalService } from "../goals.js";
import type { Scheduler } from "../scheduler.js";
import type { AttemptsService } from "../attempts.js";
import type { LlmGateway } from "../llmgateway.js";
import type { Orchestrator } from "../orchestrator.js";
import type { ObjectStore } from "../objectstore.js";
import type { EvolutionService } from "../evolution.js";
import type { EvalBroker } from "../evalbroker.js";
import type { ReleaseService } from "../releases.js";
import type { ResearchService } from "../research.js";
import type { EvidenceService } from "../evidence.js";

export interface ControlServices {
  db: Db;
  config: Config;
  objects: ObjectStore;
  auth: AuthService;
  goals: GoalService;
  scheduler: Scheduler;
  attempts: AttemptsService;
  llm: LlmGateway;
  evolution: EvolutionService;
  evalBroker: EvalBroker;
  releases: ReleaseService;
  research: ResearchService;
  evidence: EvidenceService;
  orchestrator: Orchestrator;
}
