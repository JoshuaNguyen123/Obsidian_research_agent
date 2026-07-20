export type DesignPackageKind =
  | "ui_flow"
  | "logistics_system"
  | "service_blueprint"
  | "project_ideation"
  | "architecture"
  | "mind_map"
  | "distributed_system"
  | "business_process"
  | "manufacturing_process";

export type DesignItemKind =
  | "persona"
  | "screen"
  | "actor"
  | "service"
  | "resource"
  | "queue"
  | "database"
  | "milestone"
  | "risk"
  | "metric"
  | "dependency"
  | "decision"
  | "note"
  | "client"
  | "gateway"
  | "worker"
  | "broker"
  | "cache"
  | "external_system"
  | "event"
  | "process"
  | "subprocess"
  | "document"
  | "supplier"
  | "material"
  | "inventory"
  | "operation"
  | "workcell"
  | "facility"
  | "inspection"
  | "control"
  | "output";

export interface DesignPackageItem {
  id: string;
  kind: DesignItemKind;
  title: string;
  summary: string;
  /** Optional swimlane, trust boundary, system tier, or process stage. */
  lane?: string;
  details?: string[];
  metadata?: Record<string, string | number | boolean>;
}

export interface DesignPackageEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface CreateDesignPackageInput {
  title: string;
  kind: DesignPackageKind;
  targetFolder?: string;
  items: DesignPackageItem[];
  edges: DesignPackageEdge[];
  briefMarkdown?: string;
  overwrite?: false;
  includeSvg?: boolean;
}

export interface CreateDesignPackageResult {
  canvasPath: string;
  briefPath: string;
  svgPath?: string;
  assessment: DesignPackageAssessment;
  itemCount: number;
  edgeCount: number;
  bytesWritten: number;
}

export interface DesignPackageAssessment {
  version: 1;
  profile: DesignPackageKind;
  coveredConcerns: string[];
  warnings: string[];
}
