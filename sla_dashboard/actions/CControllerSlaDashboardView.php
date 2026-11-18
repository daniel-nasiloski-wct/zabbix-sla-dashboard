<?php declare(strict_types = 0);

namespace Modules\SlaDashboard\Actions;

use API;
use APP;
use CArrayHelper;
use CController;
use CControllerResponseData;
use CControllerResponseFatal;
use CProfile;
use CRoleHelper;
use CSettingsHelper;
use CWebUser;
use Modules\SlaDashboard\Includes\CI18n;
use Modules\SlaDashboard\Includes\CSlaCollector;
use Modules\SlaDashboard\Includes\CSlaFilter;

/**
 * Página Services → SLA dashboard. Filtro no perfil do usuário (filter_set=1 grava, filter_rst=1 limpa),
 * dados calculados no PHP e entregues no bootstrap; o JS só desenha e atualiza a cada minuto.
 */
class CControllerSlaDashboardView extends CController {

	protected function init(): void {
		$this->disableCsrfValidation();
	}

	protected function checkInput(): bool {
		$ret = $this->validateInput(CSlaFilter::rules());

		if (!$ret) {
			$this->setResponse(new CControllerResponseFatal());
		}

		return $ret;
	}

	protected function checkPermissions(): bool {
		return $this->checkAccess(CRoleHelper::UI_SERVICES_SLA_REPORT);
	}

	protected function doAction(): void {
		if ($this->hasInput('filter_set')) {
			CSlaFilter::save($this->getInputAll());
		}
		elseif ($this->hasInput('filter_rst')) {
			CSlaFilter::reset();
		}

		$filter = CSlaFilter::load();
		$data = CSlaCollector::collect($filter);

		$module = APP::ModuleManager()->getModule('sla_dashboard');
		$lang = (CWebUser::$data['lang'] ?? 'default') !== 'default'
			? CWebUser::$data['lang']
			: CSettingsHelper::get(CSettingsHelper::DEFAULT_LANG);

		$response = new CControllerResponseData([
			'version' => $module !== null ? $module->getVersion() : '0',
			'filter' => $filter,
			'filter_counter' => CSlaFilter::countActive($filter),
			'active_tab' => (int) CProfile::get(CSlaFilter::PROFILE.'.active', 1),
			'ms' => self::multiselectData($filter),
			'errors' => $data['errors'],
			'can_manage_sla' => $this->checkAccess(CRoleHelper::ACTIONS_MANAGE_SLA),
			'bootstrap' => [
				'data' => $data,
				'dataUrl' => 'zabbix.php?action=sladashboard.data',
				'refreshMs' => 60000,
				'lang' => str_replace('_', '-', $lang),
				'i18n' => CI18n::strings(),
				'canManageSla' => $this->checkAccess(CRoleHelper::ACTIONS_MANAGE_SLA)
			]
		]);
		$response->setTitle(CI18n::t('SLA dashboard'));
		$this->setResponse($response);
	}

	/** Nomes dos objetos escolhidos, no formato do CMultiSelect ([id, name]). */
	private static function multiselectData(array $filter): array {
		$rename = static fn(array $rows, string $id) => array_values(CArrayHelper::renameObjectsKeys($rows, [$id => 'id']));

		return [
			'slas' => $filter['slaids']
				? $rename(API::Sla()->get(['output' => ['slaid', 'name'], 'slaids' => $filter['slaids']]), 'slaid')
				: [],
			'services' => $filter['serviceids']
				? $rename(API::Service()->get(['output' => ['serviceid', 'name'], 'serviceids' => $filter['serviceids']]), 'serviceid')
				: [],
			'groups' => $filter['groupids']
				? CArrayHelper::renameObjectsKeys(
					API::HostGroup()->get(['output' => ['groupid', 'name'], 'groupids' => $filter['groupids']]),
					['groupid' => 'id']
				)
				: [],
			'hosts' => $filter['hostids']
				? CArrayHelper::renameObjectsKeys(
					API::Host()->get(['output' => ['hostid', 'name'], 'hostids' => $filter['hostids']]),
					['hostid' => 'id']
				)
				: []
		];
	}
}
