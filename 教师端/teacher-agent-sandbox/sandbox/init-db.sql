-- 教师智能体沙箱数据库初始化
-- 执行: sqlite3 /sandbox/data/sandbox.db < init-db.sql

-- 任务记录表
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    teacher_id TEXT,
    subject TEXT,
    grade TEXT,
    topic TEXT,
    task_type TEXT,  -- lesson_plan/ppt/worksheet/assessment/unit_design/differentiation
    status TEXT DEFAULT 'pending',  -- pending/running/completed/failed
    input TEXT,       -- JSON: 输入参数
    output TEXT,      -- JSON: 输出结果
    artifacts TEXT,   -- JSON: 生成的文件列表
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

-- 文件元数据表
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    filename TEXT,
    dir TEXT,          -- 教案/课件/学案/量规/大单元/分层/试题/临时
    type TEXT,         -- mime type
    size INTEGER,
    task_id TEXT,      -- 关联的任务ID
    meta TEXT,          -- JSON: 额外元数据
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- 工具调用日志表
CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    tool_name TEXT,
    args TEXT,         -- JSON: 调用参数
    result TEXT,       -- JSON: 返回结果
    ok INTEGER,        -- 0/1
    duration_ms INTEGER,
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- 教师记忆表
CREATE TABLE IF NOT EXISTS teacher_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id TEXT,
    layer TEXT,        -- working/episodic/semantic
    key TEXT,
    value TEXT,        -- JSON
    importance REAL DEFAULT 0.5,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_tasks_teacher ON tasks(teacher_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_files_dir ON files(dir);
CREATE INDEX IF NOT EXISTS idx_files_task ON files(task_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_task ON tool_calls(task_id);
CREATE INDEX IF NOT EXISTS idx_memory_teacher_layer ON teacher_memory(teacher_id, layer);
CREATE INDEX IF NOT EXISTS idx_memory_expires ON teacher_memory(expires_at) WHERE expires_at IS NOT NULL;

-- 初始数据：默认教师配置
INSERT OR IGNORE INTO teacher_memory (teacher_id, layer, key, value, importance) VALUES
('default', 'semantic', 'preferences', '{"designStyle":"国风","primaryColor":"#4F7A66","language":"zh-CN"}', 0.9),
('default', 'semantic', 'teaching_style', '{"mode":"interactive","difficulty":"adaptive"}', 0.8);
