import { useAuthStore } from '../../stores/posStore'
import { isManagerRole } from '../../utils/roles'
import SupervisorCatalogAdopt from '../../components/catalog/SupervisorCatalogAdopt'
import ManagerNetworkCatalog from '../../components/catalog/ManagerNetworkCatalog'

/**
 * Data module:
 * - Managers maintain the universal / network catalog (manual add).
 * - Supervisors adopt from that catalog onto their branch.
 */
function ManagerData() {
  const user = useAuthStore((state) => state.user)
  if (isManagerRole(user?.role)) {
    return <ManagerNetworkCatalog />
  }
  return <SupervisorCatalogAdopt />
}

export default ManagerData
