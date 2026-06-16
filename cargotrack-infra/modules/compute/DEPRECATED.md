# DEPRECATED: EC2/ASG Compute Module

This module contains the original EC2 Auto Scaling Group + Application Load Balancer
infrastructure from CargoTrack v2 (monolith).

**Status:** DEPRECATED — Not referenced by any environment.

## Why it still exists

Kept for reference during the v2 → v3 migration review. It demonstrates the
before-state of the infrastructure (EC2-based) alongside the new EKS-based architecture.

## What replaced it

The `eks` module now handles all compute:
- `modules/eks/` — EKS cluster, OIDC provider, managed node group
- `modules/irsa/` — Per-service IAM roles (IRSA)

## Can it be deleted?

Yes. This module can be safely removed from git once the migration review is complete.
No environment references it (`environments/dev/main.tf` uses `module "eks"`, not `module "compute"`).
