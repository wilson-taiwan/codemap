import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../store/project-store";
import { Modal } from "./ui/Surfaces";

export function CloseProjectModal() {
  const { showCloseConfirm, dismissCloseConfirm, confirmCloseProject } =
    useProjectStore(
      useShallow((s) => ({
        showCloseConfirm: s.showCloseConfirm,
        dismissCloseConfirm: s.dismissCloseConfirm,
        confirmCloseProject: s.confirmCloseProject,
      })),
    );

  return (
    <Modal
      open={showCloseConfirm}
      onClose={dismissCloseConfirm}
      title="Close without handing off?"
      footer={
        <>
          <button
            type="button"
            onClick={() => dismissCloseConfirm()}
            className="btn btn-ghost"
          >
            Stay open
          </button>
          <button
            type="button"
            onClick={() => confirmCloseProject()}
            className="btn btn-primary"
          >
            Close anyway
          </button>
        </>
      }
    >
      <p className="text-[13.5px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
        Your coding is already saved on this computer — nothing is lost by
        closing. What has not happened yet is sync: your coder will not see this
        session's work until the next run, which happens automatically the next
        time you open the project with a connection.
      </p>
    </Modal>
  );
}
