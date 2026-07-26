export interface NodeMessage {
  type: string;
  originator: {
    id: string;
    type: string;
  };
  data: any;
  metadata: Record<string, any>;
  timestamp: number;
}

export interface NodeProcessorResult {
  success: boolean;
  output?: NodeMessage;
  error?: string;
  // Routing label the engine uses to pick the next connection. Binary nodes use
  // 'success' | 'failure' | 'true' | 'false'; SWITCH nodes may return any named
  // output route (e.g. 'high', 'low', 'default').
  route?: string;
}

export interface INodeProcessor {
  process(input: NodeMessage, config: any): Promise<NodeProcessorResult>;
}
