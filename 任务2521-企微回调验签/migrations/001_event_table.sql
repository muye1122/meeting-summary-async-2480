-- 回调事件表：dedup_key 唯一约束保证同一事件只入库一次。
-- 应用运行时用内存 Map 模拟；本文件表达真实关系库中的等价结构。

CREATE TABLE IF NOT EXISTS wecom_callback_event (
  dedup_key     VARCHAR(64)  NOT NULL PRIMARY KEY,
  event_type    VARCHAR(64)  NOT NULL,
  payload_json  TEXT         NOT NULL,
  received_at   TIMESTAMP    NOT NULL,
  processed_at  TIMESTAMP    NOT NULL,
  status        VARCHAR(16)  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wecom_callback_event_type
  ON wecom_callback_event (event_type);

-- 写入方式（应用逻辑）：先按 dedup_key 查询，不存在才 INSERT；
-- 重复推送直接返回 duplicate，不更新 processed_at 与 status。
