export interface SendMessageRequest {
  from_agent: string;
  to: {
    agent: string;
    session_id?: string | null;
  };
  content: string;
  message_type?: "MANAGER_MESSAGE" | "TASK_DISCUSS_REQUEST" | "TASK_DISCUSS_REPLY" | "TASK_DISCUSS_CLOSED";
  task_id?: string;
  thread_id?: string;
  round?: number;
}
