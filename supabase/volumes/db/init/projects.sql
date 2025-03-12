-- Create enum for project stages
CREATE TYPE project_stage AS ENUM (
    'Hibernating',
    'Prototyping',
    'Commenting',
    'Testing',
    'Maintaining',
    'Drifting'
);

-- Create enum for tag classes
CREATE TYPE tag_class AS ENUM (
    'tech',
    'topic',
    'event'
);

-- Create projects table
CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    handle TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL,
    creator_id INTEGER,
    revision_id INTEGER,
    modified_at TIMESTAMP,
    modifier_id INTEGER,
    maintainer_id INTEGER,
    users_url TEXT,
    developers_url TEXT,
    readme TEXT,
    next_update INTEGER,
    stage project_stage NOT NULL,
    chat_channel TEXT
);

-- Create tags table
CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    class tag_class NOT NULL,
    created_at TIMESTAMP NOT NULL,
    creator_id INTEGER,
    title TEXT NOT NULL,
    handle TEXT NOT NULL,
    description TEXT,
    items_count INTEGER
);

-- Create project_tags junction table
CREATE TABLE project_tags (
    project_id INTEGER REFERENCES projects(id),
    tag_id INTEGER REFERENCES tags(id),
    PRIMARY KEY (project_id, tag_id)
);

-- Create indexes
CREATE INDEX projects_stage_idx ON projects(stage);
CREATE INDEX tags_class_idx ON tags(class);
CREATE INDEX project_tags_project_id_idx ON project_tags(project_id);
CREATE INDEX project_tags_tag_id_idx ON project_tags(tag_id);

-- Add comments
COMMENT ON TABLE projects IS 'Code for Philly projects';
COMMENT ON TABLE tags IS 'Project tags by technology, topic, and event';
COMMENT ON TABLE project_tags IS 'Junction table linking projects to their tags';
