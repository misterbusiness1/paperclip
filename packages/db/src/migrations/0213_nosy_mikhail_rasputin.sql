CREATE INDEX "cost_events_issue_idx" ON "cost_events" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "environment_leases_issue_idx" ON "environment_leases" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "execution_workspaces_source_issue_idx" ON "execution_workspaces" USING btree ("source_issue_id");--> statement-breakpoint
CREATE INDEX "issue_attachments_issue_idx" ON "issue_attachments" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_documents_issue_idx" ON "issue_documents" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_inbox_archives_issue_idx" ON "issue_inbox_archives" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_read_states_issue_idx" ON "issue_read_states" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_recovery_actions_source_issue_idx" ON "issue_recovery_actions" USING btree ("source_issue_id");--> statement-breakpoint
CREATE INDEX "issue_recovery_actions_recovery_issue_idx" ON "issue_recovery_actions" USING btree ("recovery_issue_id");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. Production rollouts prebuild this reverse-FK index concurrently before applying the migration.
CREATE INDEX "issue_reference_mentions_source_issue_idx" ON "issue_reference_mentions" USING btree ("source_issue_id");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. Production rollouts prebuild this reverse-FK index concurrently before applying the migration.
CREATE INDEX "issue_reference_mentions_target_issue_idx" ON "issue_reference_mentions" USING btree ("target_issue_id");--> statement-breakpoint
CREATE INDEX "issue_work_products_issue_idx" ON "issue_work_products" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issues_parent_id_idx" ON "issues" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "secret_access_events_issue_idx" ON "secret_access_events" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "workspace_operations_issue_idx" ON "workspace_operations" USING btree ("issue_id");
