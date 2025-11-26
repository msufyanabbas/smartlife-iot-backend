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
  route?: string; // 'success', 'failure', 'true', 'false'
}

export interface INodeProcessor {
  process(input: NodeMessage, config: any): Promise<NodeProcessorResult>;
}
