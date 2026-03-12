# Skills Management PRD

## 1. Scope

The Skills module is the global UI for imported local skills and reusable skill lists.

It covers two views:

- `Library`
- `Lists`

It does not cover:

- editing agent registry fields
- editing skill package source files in place
- non-MiniMax provider injection behavior

## 2. Product Goals

The module provides a single entry for:

- importing local skills from filesystem paths
- standardizing imported `SKILL.md` contracts
- surfacing import warnings
- deleting imported skills
- defining reusable named skill lists

## 3. Navigation

L1 module: `Skills`

L2 views:

- `#/skills/library`
- `#/skills/lists`

## 4. Library View

### 4.1 User Capabilities

The Library view supports:

- entering one or more local source paths
- recursive directory discovery of `SKILL.md`
- triggering import
- refreshing the library list
- viewing skill metadata and warnings
- deleting an imported skill

### 4.2 Source Rules

Accepted sources:

- a directory path
- a direct `SKILL.md` file path

Current package assumption:

- the package root is the folder that contains `SKILL.md`
- only `SKILL.md` must conform to the standard contract
- other files and folders are package dependencies and are copied into managed storage

### 4.3 Displayed Metadata

Each imported skill card shows:

- `name`
- `skillId`
- `description`
- `compatibility`
- `license`
- `sourceType`
- warning list when present

### 4.4 Import Result Handling

The page surfaces:

- overall import summary
- per-import warnings
- refreshed library data after import

## 5. Lists View

### 5.1 User Capabilities

The Lists view supports:

- creating multiple skill lists
- editing display name and description
- toggling `include_all`
- selecting explicit skills
- deleting a list

### 5.2 List Semantics

A skill list contains:

- `list_id`
- `display_name`
- `description`
- `include_all`
- `skill_ids`

Resolution behavior:

- `include_all=true` dynamically includes the full imported library
- explicit `skill_ids` are appended after the dynamic set
- final runtime resolution deduplicates in order

## 6. Backend Dependency

The Skills module depends on:

- `GET /api/skills`
- `POST /api/skills/import`
- `DELETE /api/skills/:skill_id`
- `GET /api/skill-lists`
- `POST /api/skill-lists`
- `PATCH /api/skill-lists/:list_id`
- `DELETE /api/skill-lists/:list_id`

## 7. Validation and Error Behavior

### 7.1 Import Validation

The UI requires at least one path before calling import.

Backend validation may reject:

- missing source paths
- nonexistent paths
- files that are not `SKILL.md`
- directories without any `SKILL.md`

### 7.2 Skill List Validation

Backend validation may reject:

- invalid `list_id`
- unknown `skill_ids`
- deleting a list still referenced by an agent

## 8. Cross-Module Semantics

### 8.1 Agent Registry

Agents reference skill list ids from this module through the `skill_list` field.

### 8.2 Runtime Injection

Resolved imported skills are injected only on MiniMax runtime paths.

### 8.3 Storage Ownership

This module manages the global library. Project and workflow workspaces only consume the results.

## 9. Non-Goals

- direct in-app authoring of `SKILL.md`
- cross-provider transformation beyond current standard import normalization
- execution-time editing of resolved skill prompt segments

## 10. Status

Status: `ACTIVE`
