<?php declare(strict_types = 0);

namespace Modules\SlaDashboard\Actions;

use CController;
use CControllerResponseData;
use CRoleHelper;
use Modules\SlaDashboard\Includes\CSlaCollector;
use Modules\SlaDashboard\Includes\CSlaFilter;

/** JSON para a atualização automática da página (mesmo filtro salvo no perfil). */
class CControllerSlaDashboardData extends CController {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		return true;
	}

	protected function checkPermissions(): bool {
		return $this->checkAccess(CRoleHelper::UI_SERVICES_SLA_REPORT);
	}

	protected function doAction(): void {
		$data = CSlaCollector::collect(CSlaFilter::load());
		$this->setResponse(new CControllerResponseData(['main_block' => json_encode($data)]));
	}
}
