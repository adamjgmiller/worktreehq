# WorktreeHQ — Screenshots

> A visual tour of WorktreeHQ, the desktop dashboard for git worktree management and branch hygiene — with first-class squash-merge detection. Light and dark themes included.

---

## Worktree Dashboard

Every active worktree as a card: branch name, merge status, ahead/behind counts, dirty-file indicators, and per-worktree notepads — all at a glance.

<table>
<tr>
<td width="50%"><strong>Light</strong></td>
<td width="50%"><strong>Dark</strong></td>
</tr>
<tr>
<td><a href="https://github.com/user-attachments/assets/b2b579e6-03cc-49d4-a035-d46b2b159aec"><img src="https://github.com/user-attachments/assets/b2b579e6-03cc-49d4-a035-d46b2b159aec" width="100%" alt="Worktrees Dashboard — Light Mode"></a></td>
<td><a href="https://github.com/user-attachments/assets/c66efa7a-e17d-4e1d-9874-2021341e6eff"><img src="https://github.com/user-attachments/assets/c66efa7a-e17d-4e1d-9874-2021341e6eff" width="100%" alt="Worktrees Dashboard — Dark Mode"></a></td>
</tr>
</table>

---

## Quick Actions

Right-click any worktree card for instant actions — open in Finder, launch a terminal, remove the worktree, or prune stale refs.

<p align="center">
<a href="https://github.com/user-attachments/assets/19fac001-0c3b-42e0-970d-1d86a51e88a1"><img src="https://github.com/user-attachments/assets/19fac001-0c3b-42e0-970d-1d86a51e88a1" width="80%" alt="Worktree Context Menu"></a>
</p>

---

## Create Worktree

Spin up a new worktree from a new or existing branch. Optionally push to origin, set a custom path, and run post-create commands (e.g. `npm install && npm run tauri dev`) automatically in the new directory.

<table>
<tr>
<td width="50%"><strong>Light</strong></td>
<td width="50%"><strong>Dark</strong></td>
</tr>
<tr>
<td><a href="https://github.com/user-attachments/assets/353882a6-9014-48d6-a4f9-bf257eba0aaf"><img src="https://github.com/user-attachments/assets/353882a6-9014-48d6-a4f9-bf257eba0aaf" width="100%" alt="Create Worktree — Light Mode"></a></td>
<td><a href="https://github.com/user-attachments/assets/ffdc8e9e-4362-438a-9aa9-8d276fa9dc90"><img src="https://github.com/user-attachments/assets/ffdc8e9e-4362-438a-9aa9-8d276fa9dc90" width="100%" alt="Create Worktree — Dark Mode"></a></td>
</tr>
</table>

---

## Branch Management

### All Branches

Every branch at a glance — local and remote status, merge detection results (merged, squash-merged, or unmerged), ahead/behind counts relative to main, linked PRs, and last commit date. Filter by status or search by name.

<table>
<tr>
<td width="50%"><strong>Light</strong></td>
<td width="50%"><strong>Dark</strong></td>
</tr>
<tr>
<td><a href="https://github.com/user-attachments/assets/19f41c5d-23d3-4a36-a184-49e37fd096ff"><img src="https://github.com/user-attachments/assets/19f41c5d-23d3-4a36-a184-49e37fd096ff" width="100%" alt="Branches Tab — Light Mode"></a></td>
<td><a href="https://github.com/user-attachments/assets/1f74b77f-7d51-4e51-806e-4c3d69717fa3"><img src="https://github.com/user-attachments/assets/1f74b77f-7d51-4e51-806e-4c3d69717fa3" width="100%" alt="Branches Tab — Dark Mode"></a></td>
</tr>
</table>

### Safe to Delete

The killer feature: one click filters to branches that are merged, squash-merged, or stale — the ones piling up in your repo that every other git GUI tells you are "unmerged." Select all and bulk-delete with confidence.

<table>
<tr>
<td width="50%"><strong>Light</strong></td>
<td width="50%"><strong>Dark</strong></td>
</tr>
<tr>
<td><a href="https://github.com/user-attachments/assets/e7119056-0506-4c08-98ab-5901defbd78e"><img src="https://github.com/user-attachments/assets/e7119056-0506-4c08-98ab-5901defbd78e" width="100%" alt="Safe to Delete — Light Mode"></a></td>
<td><a href="https://github.com/user-attachments/assets/d52a7b05-3cc5-44d1-a2aa-db608508dca9"><img src="https://github.com/user-attachments/assets/d52a7b05-3cc5-44d1-a2aa-db608508dca9" width="100%" alt="Safe to Delete — Dark Mode"></a></td>
</tr>
</table>

### Bulk Delete with Confirmation

Select branches to remove, review the exact local and remote refs that will be deleted, and type to confirm. No accidental deletions — every ref is listed before anything is touched.

<table>
<tr>
<td width="50%"><strong>Light</strong></td>
<td width="50%"><strong>Dark</strong></td>
</tr>
<tr>
<td><a href="https://github.com/user-attachments/assets/d62b0f51-93e2-4918-9664-55c213aaecc6"><img src="https://github.com/user-attachments/assets/d62b0f51-93e2-4918-9664-55c213aaecc6" width="100%" alt="Bulk Delete Confirmation — Light Mode"></a></td>
<td><a href="https://github.com/user-attachments/assets/ff2717c5-6fde-4231-9e77-9a217f7f6c5f"><img src="https://github.com/user-attachments/assets/ff2717c5-6fde-4231-9e77-9a217f7f6c5f" width="100%" alt="Bulk Delete Confirmation — Dark Mode"></a></td>
</tr>
</table>

---

## Worktree Conflict Detection

Spot trouble before it starts. The Conflicts tab detects when two worktrees modify the same files and shows a side-by-side diff of the overlapping changes — so you know about conflicts before you try to merge.

<table>
<tr>
<td width="50%"><strong>Light</strong></td>
<td width="50%"><strong>Dark</strong></td>
</tr>
<tr>
<td><a href="https://github.com/user-attachments/assets/b75bcdf2-8124-4ec8-8aad-285ff40e21be"><img src="https://github.com/user-attachments/assets/b75bcdf2-8124-4ec8-8aad-285ff40e21be" width="100%" alt="Conflicts View — Light Mode"></a></td>
<td><a href="https://github.com/user-attachments/assets/7aeecd1f-e404-4a71-95d8-2b5255930ad6"><img src="https://github.com/user-attachments/assets/7aeecd1f-e404-4a71-95d8-2b5255930ad6" width="100%" alt="Conflicts View — Dark Mode"></a></td>
</tr>
</table>

---

## Settings

Authenticate via the GitHub CLI (recommended — no token stored), a personal access token, or skip auth entirely for offline use. Configure post-create commands that run in every new worktree.

<table>
<tr>
<td width="50%"><strong>Light</strong></td>
<td width="50%"><strong>Dark</strong></td>
</tr>
<tr>
<td><a href="https://github.com/user-attachments/assets/03c51313-3422-4127-9004-d6f792c50db8"><img src="https://github.com/user-attachments/assets/03c51313-3422-4127-9004-d6f792c50db8" width="100%" alt="Settings — Light Mode"></a></td>
<td><a href="https://github.com/user-attachments/assets/2f6ef578-77c6-4db2-9de0-17f314b78b8f"><img src="https://github.com/user-attachments/assets/2f6ef578-77c6-4db2-9de0-17f314b78b8f" width="100%" alt="Settings — Dark Mode"></a></td>
</tr>
</table>

---

## Keyboard Shortcuts & Multi-Repo Support

Navigate tabs, switch repos, create worktrees, trigger refreshes, and manage branch selections — all from the keyboard. Switch between repositories instantly from the dropdown.

<table>
<tr>
<td width="50%"><strong>Keyboard Shortcuts</strong></td>
<td width="50%"><strong>Repo Picker</strong></td>
</tr>
<tr>
<td><a href="https://github.com/user-attachments/assets/378e4502-2197-4844-aef2-08e1433dbbb0"><img src="https://github.com/user-attachments/assets/378e4502-2197-4844-aef2-08e1433dbbb0" width="100%" alt="Keyboard Shortcuts"></a></td>
<td><a href="https://github.com/user-attachments/assets/bc61bb29-af8a-437b-9d6c-9aeb7bd524df"><img src="https://github.com/user-attachments/assets/bc61bb29-af8a-437b-9d6c-9aeb7bd524df" width="100%" alt="Repo Picker"></a></td>
</tr>
</table>

---

## Worktree Archive

When you remove a worktree, its notepad content is preserved in the archive — so your notes, context, and TODO lists aren't lost when you clean up. Browse, copy, or permanently delete archived entries.

<table>
<tr>
<td width="50%"><strong>Light</strong></td>
<td width="50%"><strong>Dark</strong></td>
</tr>
<tr>
<td><a href="https://github.com/user-attachments/assets/22848f9d-0e34-443c-afa8-57783b23a39e"><img src="https://github.com/user-attachments/assets/22848f9d-0e34-443c-afa8-57783b23a39e" width="100%" alt="Worktree Archive — Light Mode"></a></td>
<td><a href="https://github.com/user-attachments/assets/85573f7b-bb8f-4b22-960c-4643bc8c92a9"><img src="https://github.com/user-attachments/assets/85573f7b-bb8f-4b22-960c-4643bc8c92a9" width="100%" alt="Worktree Archive — Dark Mode"></a></td>
</tr>
</table>
