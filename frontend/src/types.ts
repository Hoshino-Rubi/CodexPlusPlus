export interface ThreadSummary { id: string; title: string; cwd?: string }
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'reasoning' | 'tool';
  text: string;
  status?: 'streaming' | 'completed' | 'failed';
}
export interface ApprovalRequest {
  id: string | number;
  method: string;
  params: unknown;
}
