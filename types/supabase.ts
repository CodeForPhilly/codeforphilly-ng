/**
 * Generated types for Supabase schema
 */

/**
 * Project stage enum type
 */
export type ProjectStage =
  | 'Hibernating'
  | 'Prototyping'
  | 'Commenting'
  | 'Testing'
  | 'Maintaining'
  | 'Drifting'

/**
 * Tag class enum type
 */
export type TagClass =
  | 'tech'
  | 'topic'
  | 'event'

/**
 * Project model
 */
export interface Project {
  id: number
  title: string
  handle: string
  created_at: string
  creator_id: number | null
  revision_id: number | null
  modified_at: string | null
  modifier_id: number | null
  maintainer_id: number | null
  users_url: string | null
  developers_url: string | null
  readme: string | null
  next_update: number | null
  stage: ProjectStage
  chat_channel: string | null
}

/**
 * Tag model
 */
export interface Tag {
  id: number
  class: TagClass
  created_at: string
  creator_id: number | null
  title: string
  handle: string
  description: string | null
  items_count: number | null
}

/**
 * Project tags junction model
 */
export interface ProjectTag {
  project_id: number
  tag_id: number
}

/**
 * Transformed project with nested tags
 */
export interface ProjectWithTags extends Omit<Project, 'project_tags'> {
  tags: Tag[]
}

/**
 * Database schema type
 */
export interface Database {
  public: {
    Tables: {
      projects: {
        Row: Project
        Insert: Omit<Project, 'id' | 'created_at'>
        Update: Partial<Omit<Project, 'id' | 'created_at'>>
      }
      tags: {
        Row: Tag
        Insert: Omit<Tag, 'id' | 'created_at'>
        Update: Partial<Omit<Tag, 'id' | 'created_at'>>
      }
      project_tags: {
        Row: ProjectTag
        Insert: ProjectTag
        Update: Partial<ProjectTag>
      }
    }
    Views: {}
    Functions: {}
    Enums: {
      project_stage: ProjectStage
      tag_class: TagClass
    }
  }
}
