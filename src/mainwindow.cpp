#include "mainwindow.h"
#include "bytearray_writable.hpp"
#include "isodatetimeedit.h"
#include "ros2_compressed_image.h"
#include "timerangeslider.h"
#include "ui_mainwindow.h"
#include "videopreviewwidget.h"

#include <QCoreApplication>
#include <QDir>
#include <QDragEnterEvent>
#include <QDropEvent>
#include <QFileDialog>
#include <QFileInfo>
#include <QFileSystemModel>
#include <QImage>
#include <QItemSelectionModel>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLocale>
#include <QMetaObject>
#include <QMessageBox>
#include <QMimeData>
#include <QPointer>
#include <QProgressDialog>
#include <QSaveFile>
#include <QSettings>
#include <QSignalBlocker>
#include <QStatusBar>
#include <QStyle>
#include <QThreadPool>
#include <QTimeZone>
#include <QTimer>
#include <QUrl>

#include <algorithm>
#include <fstream>
#include <limits>
#include <set>
#include <string>
#include <string_view>
#include <utility>

MainWindow::MainWindow(QWidget* parent) : QMainWindow(parent), ui(new Ui::MainWindow)
{
  ui->setupUi(this);
  setAcceptDrops(true);
  ui->sourceSplitter->setStretchFactor(0, 0);
  ui->sourceSplitter->setStretchFactor(1, 1);
  ui->splitter->setStretchFactor(0, 7);
  ui->splitter->setStretchFactor(1, 3);
  ui->inspectorSplitter->setStretchFactor(0, 3);
  ui->inspectorSplitter->setStretchFactor(1, 2);
  ui->gridLayoutRangeFields->setColumnStretch(1, 1);

  QSettings settings;
  const QByteArray source_splitter_state =
      settings.value("MainWindow.sourceSplitter").toByteArray();
  const QByteArray main_splitter_state =
      settings.value("MainWindow.mainSplitter").toByteArray();
  const QByteArray inspector_splitter_state =
      settings.value("MainWindow.inspectorSplitter").toByteArray();
  if (!main_splitter_state.isEmpty())
  {
    ui->splitter->restoreState(main_splitter_state);
  }
  else
  {
    ui->splitter->setSizes({820, 400});
  }
  if (!source_splitter_state.isEmpty())
  {
    ui->sourceSplitter->restoreState(source_splitter_state);
  }
  else
  {
    ui->sourceSplitter->setSizes({220, 1000});
  }
  if (!inspector_splitter_state.isEmpty())
  {
    ui->inspectorSplitter->restoreState(inspector_splitter_state);
  }
  else
  {
    ui->inspectorSplitter->setSizes({390, 260});
  }

  QPalette subtitle_palette = ui->labelDocumentSubtitle->palette();
  subtitle_palette.setColor(
      QPalette::WindowText,
      palette().color(QPalette::PlaceholderText));
  ui->labelDocumentSubtitle->setPalette(subtitle_palette);

  ui->tableTopics->setColumnHidden(1, true);
  ui->tableTopics->setColumnHidden(2, true);
  ui->tableTopics->horizontalHeader()->setSectionResizeMode(
      0, QHeaderView::Stretch);
  ui->tableTopics->horizontalHeader()->setSectionResizeMode(
      3, QHeaderView::ResizeToContents);
  ui->buttonCloseFolder->setIcon(
      style()->standardIcon(QStyle::SP_TitleBarCloseButton));
  ui->buttonCloseFolder->setText({});
  ui->sourceSidebar->setVisible(false);
  ui->labelFolderEmpty->setVisible(false);
  connect(ui->timeRangeSlider, &TimeRangeSlider::lowerValueChanged, this,
          [this](qint64 value) {
            ui->dateTimeStartNew->setDateTime(QDateTime::fromMSecsSinceEpoch(value));
          });
  connect(ui->timeRangeSlider, &TimeRangeSlider::upperValueChanged, this,
          [this](qint64 value) {
            ui->dateTimeEndNew->setDateTime(QDateTime::fromMSecsSinceEpoch(value));
          });
  connect(ui->dateTimeStartNew, &QDateTimeEdit::dateTimeChanged, this,
          [this](const QDateTime& value) {
            ui->timeRangeSlider->setLowerValue(value.toMSecsSinceEpoch());
            updateVideoTrimRange();
            ui->videoPreview->seekToTimestamp(
                static_cast<quint64>(value.toMSecsSinceEpoch()) * 1'000'000ULL);
            updateExportAvailability();
          });
  connect(ui->dateTimeEndNew, &QDateTimeEdit::dateTimeChanged, this,
          [this](const QDateTime& value) {
            ui->timeRangeSlider->setUpperValue(value.toMSecsSinceEpoch());
            updateVideoTrimRange();
            ui->videoPreview->seekToTimestamp(
                static_cast<quint64>(value.toMSecsSinceEpoch()) * 1'000'000ULL);
            updateExportAvailability();
          });
  connect(ui->videoPreview, &VideoPreviewWidget::streamSelected, this,
          [this](quint16 channel_id, const QString& topic) {
            beginVideoIndex(static_cast<mcap::ChannelId>(channel_id), topic);
          });
  connect(ui->videoPreview, &VideoPreviewWidget::frameRequested, this,
          &MainWindow::requestVideoFrame);

#ifdef USING_WASM
  ui->buttonLoad->setText("Upload MCAP…");
  ui->buttonSave->setText("Export and Download");
  ui->buttonOpenFolder->setVisible(false);
  ui->videoPreview->setVisible(false);
#else
  ui->horizontalWidgetSaveAs->setHidden(true);

  file_system_model_ = new QFileSystemModel(this);
  file_system_model_->setReadOnly(true);
  file_system_model_->setFilter(QDir::Files | QDir::NoDotAndDotDot);
  file_system_model_->setNameFilters(
      {QStringLiteral("*.mcap"), QStringLiteral("*.MCAP")});
  file_system_model_->setNameFilterDisables(false);
  ui->listFiles->setModel(file_system_model_);
  ui->listFiles->setModelColumn(0);

  connect(file_system_model_, &QFileSystemModel::directoryLoaded, this,
          [this](const QString& path) {
            if (QDir::cleanPath(path) ==
                QDir::cleanPath(current_folder_))
            {
              folder_model_loaded_ = true;
              refreshFolderListState();
            }
          });
  connect(file_system_model_, &QFileSystemModel::rowsInserted, this,
          [this]() { refreshFolderListState(); });
  connect(file_system_model_, &QFileSystemModel::rowsRemoved, this,
          [this]() { refreshFolderListState(); });
  connect(ui->listFiles->selectionModel(),
          &QItemSelectionModel::currentChanged, this,
          [this](const QModelIndex& current,
                 const QModelIndex&) {
            if (!current.isValid() || current_folder_.isEmpty())
            {
              return;
            }
            const QString path = file_system_model_->filePath(current);
            if (QFileInfo(path).isFile())
            {
              beginFileLoad(path, false);
            }
          });
#endif
  resetRecordingUi(
      QStringLiteral("Open or drop an MCAP file to begin"));
}

MainWindow::~MainWindow()
{
  QSettings settings;
  if (ui->sourceSidebar->isVisible())
  {
    settings.setValue("MainWindow.sourceSplitter",
                      ui->sourceSplitter->saveState());
  }
  settings.setValue("MainWindow.mainSplitter", ui->splitter->saveState());
  settings.setValue("MainWindow.inspectorSplitter",
                    ui->inspectorSplitter->saveState());
  delete ui;
}

void MainWindow::openFile()
{
  QSettings settings;

  QString dir =
      settings.value("MainWindow.lastDirectoryLoad", QDir::currentPath()).toString();

  auto filename =
      QFileDialog::getOpenFileName(this, "Open an MCAP file", dir, "MCAP files (*.mcap)");

  if (!filename.isEmpty())
  {
    dir = QFileInfo(filename).absolutePath();
    settings.setValue("MainWindow.lastDirectoryLoad", dir);
    openFilePath(filename);
  }
}

void MainWindow::openFilePath(const QString& filename)
{
  if (QFileInfo(filename).isDir())
  {
    openFolderPath(filename);
    return;
  }
  beginFileLoad(filename, true);
}

void MainWindow::openFolder()
{
#ifdef USING_WASM
  return;
#else
  QSettings settings;
  const QString initial_directory =
      settings
          .value("MainWindow.lastFolderLoad",
                 settings.value("MainWindow.lastDirectoryLoad",
                                QDir::currentPath()))
          .toString();
  const QString folder = QFileDialog::getExistingDirectory(
      this, "Open a folder of MCAP files", initial_directory);
  if (!folder.isEmpty())
  {
    settings.setValue("MainWindow.lastFolderLoad", folder);
    openFolderPath(folder);
  }
#endif
}

void MainWindow::openFolderPath(const QString& folder)
{
#ifdef USING_WASM
  Q_UNUSED(folder);
  return;
#else
  const QFileInfo folder_info(folder);
  if (!folder_info.exists() || !folder_info.isDir())
  {
    QMessageBox::warning(this, "Unable to open folder",
                         "The selected folder does not exist.");
    return;
  }

  ++file_load_generation_;
  folder_model_loaded_ = false;
  selected_topics_.clear();
  updateTopicSelectionSummary();
  current_folder_ = folder_info.canonicalFilePath();
  if (current_folder_.isEmpty())
  {
    current_folder_ = folder_info.absoluteFilePath();
  }

  const bool source_sidebar_was_hidden =
      !ui->sourceSidebar->isVisible();
  ui->labelFolderName->setText(folder_info.fileName().isEmpty() ?
                                   current_folder_ :
                                   folder_info.fileName());
  ui->labelFolderName->setToolTip(current_folder_);
  ui->sourceSidebar->setVisible(true);
  if (source_sidebar_was_hidden)
  {
    QSettings settings;
    const QByteArray state =
        settings.value("MainWindow.sourceSplitter").toByteArray();
    if (!state.isEmpty())
    {
      ui->sourceSplitter->restoreState(state);
    }
    else
    {
      ui->sourceSplitter->setSizes(
          {220, std::max(1, width() - 220)});
    }
  }
  ui->labelFolderEmpty->setVisible(false);
  ui->listFiles->setVisible(true);

  const bool model_root_already_loaded =
      QDir::cleanPath(file_system_model_->rootPath()) ==
      QDir::cleanPath(current_folder_);
  const QModelIndex root =
      file_system_model_->setRootPath(current_folder_);
  folder_model_loaded_ = model_root_already_loaded;
  ui->listFiles->setRootIndex(root);
  ui->listFiles->clearSelection();
  ui->listFiles->setCurrentIndex({});
  file_system_model_->sort(0, Qt::AscendingOrder);

  QTimer::singleShot(0, this,
                     [this]() { refreshFolderListState(); });
#endif
}

void MainWindow::closeFolderSession()
{
  ++file_load_generation_;
  folder_model_loaded_ = false;
  current_folder_.clear();
  selected_topics_.clear();
  QSettings().setValue("MainWindow.sourceSplitter",
                       ui->sourceSplitter->saveState());
  ui->sourceSidebar->setVisible(false);
  resetRecordingUi(QStringLiteral("Open or drop an MCAP file to begin"));
}

void MainWindow::refreshFolderListState()
{
#ifdef USING_WASM
  return;
#else
  if (current_folder_.isEmpty() || file_system_model_ == nullptr)
  {
    return;
  }
  const QModelIndex root =
      file_system_model_->index(current_folder_);
  if (!root.isValid())
  {
    return;
  }

  ui->listFiles->setRootIndex(root);
  file_system_model_->sort(0, Qt::AscendingOrder);
  const int count = file_system_model_->rowCount(root);
  ui->labelFolderEmpty->setVisible(count == 0);
  ui->listFiles->setVisible(count != 0);
  if (folder_model_loaded_ && count > 0 &&
      !ui->listFiles->currentIndex().isValid())
  {
    ui->listFiles->setCurrentIndex(
        file_system_model_->index(0, 0, root));
  }
  else if (count == 0)
  {
    resetRecordingUi(
        QStringLiteral("No MCAP files in this folder"));
  }
#endif
}

void MainWindow::beginFileLoad(const QString& filename,
                               bool reset_selection_session)
{
  const QFileInfo file_info(filename);
  if (!file_info.exists() || !file_info.isFile())
  {
    QMessageBox::warning(this, "Unable to open file",
                         "The selected MCAP file does not exist.");
    return;
  }

  if (file_info.suffix().compare(QStringLiteral("mcap"),
                                 Qt::CaseInsensitive) != 0)
  {
    QMessageBox::warning(this, "Unable to open file",
                         "The selected file is not an MCAP file.");
    return;
  }

  if (reset_selection_session)
  {
    folder_model_loaded_ = false;
    current_folder_.clear();
    selected_topics_.clear();
    if (ui->sourceSidebar->isVisible())
    {
      QSettings().setValue("MainWindow.sourceSplitter",
                           ui->sourceSplitter->saveState());
    }
    ui->sourceSidebar->setVisible(false);
    updateTopicSelectionSummary();
  }

  ++file_load_generation_;
  const quint64 generation = file_load_generation_;
  const QString absolute_path = file_info.absoluteFilePath();
  resetRecordingUi(QStringLiteral("Loading %1…").arg(file_info.fileName()));
  ui->labelDocumentTitle->setText(file_info.fileName());
  statusBar()->showMessage(
      QStringLiteral("Loading %1…").arg(file_info.fileName()));

  QPointer<MainWindow> guard(this);
  QThreadPool::globalInstance()->start(
      [guard, generation, absolute_path]() {
        RecordingSnapshot snapshot;
        QString error_message;
        const bool loaded = loadRecordingSnapshotFromFile(
            absolute_path, snapshot, error_message);
        if (!guard)
        {
          return;
        }
        QMetaObject::invokeMethod(
            guard.data(),
            [guard, generation, loaded,
             snapshot = std::move(snapshot),
             error_message = std::move(error_message)]() mutable {
              if (!guard ||
                  guard->file_load_generation_ != generation)
              {
                return;
              }
              if (!loaded)
              {
                guard->resetRecordingUi(
                    QStringLiteral("Unable to load recording"));
                guard->statusBar()->clearMessage();
                QMessageBox::warning(guard, "Unable to open file",
                                     error_message);
                return;
              }
              guard->applyRecordingSnapshot(std::move(snapshot));
            },
            Qt::QueuedConnection);
      });
}

void MainWindow::openFileWASM()
{
  auto fileContentReady = [this](const QString& fileName, const QByteArray& fileContent) {
    if (!fileName.isEmpty())
    {
      read_buffer_ = fileContent;
      selected_topics_.clear();
      current_folder_.clear();
      resetRecordingUi(
          QStringLiteral("Loading %1…")
              .arg(QFileInfo(fileName).fileName()));

      mcap::BufferReader buffer;
      buffer.reset(reinterpret_cast<const std::byte*>(fileContent.data()),
                   fileContent.size(), fileContent.size());

      mcap::McapReader reader;
      auto res = reader.open(buffer);
      if (!res.ok())
      {
        QMessageBox::warning(this, "Error opening file",
                             QString::fromStdString(res.message));
        return;
      }

      RecordingSnapshot snapshot;
      QString error_message;
      if (buildRecordingSnapshot(
              reader, buffer, fileName,
              static_cast<uint64_t>(fileContent.size()), snapshot,
              error_message))
      {
        applyRecordingSnapshot(std::move(snapshot));
        ui->lineEditSaveAs->setText(
            QStringLiteral("%1-slice.mcap").arg(QFileInfo(fileName).completeBaseName()));
      }
      else
      {
        resetRecordingUi(QStringLiteral("Unable to load recording"));
        QMessageBox::warning(this, "Error opening file",
                             error_message);
      }
    }
  };

  QFileDialog::getOpenFileContent("MCAP files (*.mcap)", fileContentReady);
}

bool MainWindow::saveFile(const mcap::McapWriterOptions& options)
{
  QSettings settings;
  QString dir =
      settings.value("MainWindow.lastDirectorySave", QDir::currentPath()).toString();

  const QString suggested_name =
      QStringLiteral("%1-slice.mcap").arg(QFileInfo(file_opened_).completeBaseName());
  QString filename = QFileDialog::getSaveFileName(this, "Export MCAP file",
                                                  QDir(dir).filePath(suggested_name),
                                                  "MCAP files (*.mcap)");

  if (filename.isEmpty())
  {
    return false;
  }
  if (QFileInfo(filename).suffix().compare("mcap", Qt::CaseInsensitive) != 0)
  {
    filename += ".mcap";
  }

  const auto normalized_path = [](const QString& path) {
    const QFileInfo info(path);
    const QString canonical = info.canonicalFilePath();
    return canonical.isEmpty() ? QDir::cleanPath(info.absoluteFilePath()) : canonical;
  };
  if (normalized_path(filename).compare(normalized_path(file_opened_),
                                        Qt::CaseInsensitive) == 0)
  {
    QMessageBox::warning(this, "Choose a different destination",
                         "MCAP Slice never overwrites the source file. Choose a new "
                         "filename.");
    return false;
  }

  dir = QFileInfo(filename).absolutePath();
  settings.setValue("MainWindow.lastDirectorySave", dir);

  QSaveFile output(filename);
  if (!output.open(QIODevice::WriteOnly))
  {
    QMessageBox::warning(this, "Unable to export file", output.errorString());
    return false;
  }

  QIODeviceInterface output_adapter(output);
  mcap::McapWriter writer;
  writer.open(output_adapter, options);

  QString error_message;
  const WriteResult result = writeMCAP(writer, error_message);
  writer.close();

  if (result != WriteResult::Success || !output_adapter.ok())
  {
    output.cancelWriting();
    if (result == WriteResult::Failed || !output_adapter.ok())
    {
      if (error_message.isEmpty())
      {
        error_message = output_adapter.errorMessage();
      }
      QMessageBox::warning(this, "Unable to export file", error_message);
    }
    return false;
  }

  if (!output.commit())
  {
    QMessageBox::warning(this, "Unable to export file", output.errorString());
    return false;
  }

  statusBar()->showMessage(
      QStringLiteral("Exported %1").arg(QFileInfo(filename).fileName()), 6000);
  return true;
}

bool MainWindow::saveFileWASM(const mcap::McapWriterOptions& options)
{
  ByteArrayInterface array;
  mcap::McapWriter writer;
  writer.open(array, options);

  QString error_message;
  const WriteResult result = writeMCAP(writer, error_message);
  writer.close();

  if (result != WriteResult::Success)
  {
    if (result == WriteResult::Failed)
    {
      QMessageBox::warning(this, "Unable to export file", error_message);
    }
    return false;
  }

  QFileDialog::saveFileContent(array.byteArray(), ui->lineEditSaveAs->text());
  return true;
}

void MainWindow::on_buttonLoad_clicked()
{
#ifdef USING_WASM
  openFileWASM();
#else
  openFile();
#endif
}

void MainWindow::on_buttonOpenFolder_clicked()
{
  openFolder();
}

void MainWindow::on_buttonCloseFolder_clicked()
{
  closeFolderSession();
}

void MainWindow::on_buttonSave_clicked()
{
  if (!validateExportSettings())
  {
    return;
  }

  mcap::McapWriterOptions options(profile_);
  if (ui->radioLZ4->isChecked())
  {
    options.compression = mcap::Compression::Lz4;
  }
  else if (ui->radioZSTD->isChecked())
  {
    options.compression = mcap::Compression::Zstd;
  }
  else
  {
    options.compression = mcap::Compression::None;
  }

  ui->buttonSave->setEnabled(false);
  ui->buttonSave->setText("Exporting…");
  QCoreApplication::processEvents();

#ifdef USING_WASM
  saveFileWASM(options);
  ui->buttonSave->setText("Export and Download");
#else
  saveFile(options);
  ui->buttonSave->setText("Export…");
#endif
  updateExportAvailability();
}

bool MainWindow::buildRecordingSnapshot(
    mcap::McapReader& reader, mcap::IReadable& source,
    const QString& source_name, uint64_t source_size,
    RecordingSnapshot& snapshot, QString& error_message)
{
  snapshot = {};
  snapshot.source_name = source_name;
  snapshot.source_size = source_size;
  error_message.clear();

  auto status =
      reader.readSummary(mcap::ReadSummaryMethod::AllowFallbackScan);
  if (!status.ok())
  {
    error_message = QString::fromStdString(status.message);
    return false;
  }

  const auto statistics = reader.statistics();
  if (!statistics.has_value())
  {
    error_message = QStringLiteral("The recording has no readable statistics.");
    return false;
  }
  if (statistics->messageCount == 0)
  {
    error_message =
        QStringLiteral("This MCAP file contains no messages to trim.");
    return false;
  }

  snapshot.profile = reader.header()->profile;
  snapshot.message_count = statistics->messageCount;
  snapshot.channel_count = statistics->channelCount;
  snapshot.time_start = statistics->messageStartTime;
  snapshot.time_end = statistics->messageEndTime;

  for (const auto& [schema_id, schema] : reader.schemas())
  {
    snapshot.schemas[schema_id] =
        {schema->name, schema->encoding, schema->data};
  }
  for (const auto& [channel_id, channel] : reader.channels())
  {
    snapshot.channels[channel_id] = {
        channel->topic,
        channel->messageEncoding,
        channel->schemaId,
        channel->metadata,
    };
    const auto count =
        statistics->channelMessageCounts.find(channel_id);
    snapshot.channel_message_counts[channel_id] =
        count == statistics->channelMessageCounts.end() ?
            0 :
            count->second;
  }

  std::vector<mcap::MetadataIndex> metadata_indexes;
  metadata_indexes.reserve(reader.metadataIndexes().size());
  for (const auto& [_, index] : reader.metadataIndexes())
  {
    metadata_indexes.push_back(index);
  }
  std::sort(metadata_indexes.begin(), metadata_indexes.end(),
            [](const mcap::MetadataIndex& left,
               const mcap::MetadataIndex& right) {
              return left.offset < right.offset;
            });

  for (const auto& index : metadata_indexes)
  {
    mcap::Record record;
    status = mcap::McapReader::ReadRecord(source, index.offset, &record);
    if (!status.ok())
    {
      snapshot.metadata_error =
          QStringLiteral("Unable to read source Metadata '%1': %2")
              .arg(QString::fromStdString(index.name),
                   QString::fromStdString(status.message));
      snapshot.metadata.clear();
      break;
    }

    mcap::Metadata metadata;
    status = mcap::McapReader::ParseMetadata(record, &metadata);
    if (!status.ok())
    {
      snapshot.metadata_error =
          QStringLiteral("Unable to parse source Metadata '%1': %2")
              .arg(QString::fromStdString(index.name),
                   QString::fromStdString(status.message));
      snapshot.metadata.clear();
      break;
    }
    snapshot.metadata.push_back(std::move(metadata));
  }

  return true;
}

bool MainWindow::loadRecordingSnapshotFromFile(
    const QString& filename, RecordingSnapshot& snapshot,
    QString& error_message)
{
  std::ifstream stream(filename.toStdString(), std::ios::binary);
  if (!stream)
  {
    error_message =
        QStringLiteral("Unable to open %1.").arg(filename);
    return false;
  }

  mcap::FileStreamReader source(stream);
  mcap::McapReader reader;
  const auto status = reader.open(source);
  if (!status.ok())
  {
    error_message = QString::fromStdString(status.message);
    return false;
  }
  return buildRecordingSnapshot(
      reader, source, filename,
      static_cast<uint64_t>(QFileInfo(filename).size()), snapshot,
      error_message);
}

void MainWindow::resetRecordingUi(const QString& status_text)
{
  file_opened_.clear();
  profile_.clear();
  schema_by_id_.clear();
  channel_by_id_.clear();
  source_metadata_.clear();
  source_metadata_error_.clear();
  source_file_size_ = 0;
  time_start_ = 0;
  time_end_ = 0;

  resetVideoPreview();
  const QSignalBlocker blocker(ui->tableTopics);
  ui->tableTopics->clearContents();
  ui->tableTopics->setRowCount(0);
  ui->textSchema->clear();
  ui->lineProfile->clear();
  ui->labelDocumentTitle->setText(QStringLiteral("No recording open"));
  ui->labelDocumentSubtitle->setText(status_text);
  ui->rangeSection->setEnabled(false);
  ui->widgetSave->setEnabled(false);
  ui->buttonSave->setEnabled(false);
  setWindowTitle(QStringLiteral("MCAP Slice"));
  updateTopicSelectionSummary();
}

void MainWindow::applyRecordingSnapshot(
    RecordingSnapshot&& snapshot)
{
  file_opened_ = snapshot.source_name;
  source_file_size_ = snapshot.source_size;
  profile_ = std::move(snapshot.profile);
  time_start_ = snapshot.time_start;
  time_end_ = snapshot.time_end;
  schema_by_id_ = std::move(snapshot.schemas);
  channel_by_id_ = std::move(snapshot.channels);
  source_metadata_ = std::move(snapshot.metadata);
  source_metadata_error_ = std::move(snapshot.metadata_error);

  ui->labelDocumentTitle->setText(
      QFileInfo(file_opened_).fileName());
  const double duration_seconds =
      static_cast<double>(time_end_ - time_start_) /
      1'000'000'000.0;
  ui->labelDocumentSubtitle->setText(
      QStringLiteral("%1 messages · %2 topics · %3 s")
          .arg(QLocale().toString(
              static_cast<qulonglong>(snapshot.message_count)))
          .arg(QLocale().toString(
              static_cast<qulonglong>(snapshot.channel_count)))
          .arg(QLocale().toString(duration_seconds, 'f', 3)));
  ui->lineProfile->setText(QString::fromStdString(profile_));

  populating_topics_ = true;
  {
    const QSignalBlocker blocker(ui->tableTopics);
    const bool sorting_enabled = ui->tableTopics->isSortingEnabled();
    ui->tableTopics->setSortingEnabled(false);
    ui->tableTopics->clearContents();
    ui->tableTopics->setRowCount(0);

    for (const auto& [channel_id, channel] : channel_by_id_)
    {
      QString schema_name = QStringLiteral("—");
      if (channel.schema_id != 0)
      {
        const auto schema_it =
            schema_by_id_.find(channel.schema_id);
        schema_name =
            schema_it == schema_by_id_.end() ?
                QStringLiteral("Unknown") :
                QString::fromStdString(schema_it->second.name);
      }

      const int row = ui->tableTopics->rowCount();
      ui->tableTopics->insertRow(row);
      auto* channel_item = new QTableWidgetItem(
          QString::fromStdString(channel.topic));
      channel_item->setData(Qt::UserRole,
                            static_cast<uint>(channel_id));
      channel_item->setCheckState(
          selected_topics_.count(channel.topic) != 0 ?
              Qt::Checked :
              Qt::Unchecked);
      ui->tableTopics->setItem(row, 0, channel_item);
      ui->tableTopics->setItem(
          row, 1, new QTableWidgetItem(schema_name));
      ui->tableTopics->setItem(
          row, 2,
          new QTableWidgetItem(
              QString::fromStdString(channel.message_encoding)));
      const auto count =
          snapshot.channel_message_counts.find(channel_id);
      ui->tableTopics->setItem(
          row, 3,
          new QTableWidgetItem(QString::number(
              count == snapshot.channel_message_counts.end() ?
                  0 :
                  count->second)));
    }
    ui->tableTopics->setSortingEnabled(sorting_enabled);
  }
  populating_topics_ = false;

  const QDateTime epoch = QDateTime::fromMSecsSinceEpoch(
      0, IsoTimestamp::displayTimeZone());
  const QDateTime maximum(
      QDate(9999, 12, 31), QTime(23, 59, 59, 999),
      IsoTimestamp::displayTimeZone());
  const QDateTime start_date = QDateTime::fromMSecsSinceEpoch(
      static_cast<qint64>(time_start_ / 1'000'000ULL),
      IsoTimestamp::displayTimeZone());
  const QDateTime end_date = QDateTime::fromMSecsSinceEpoch(
      static_cast<qint64>(time_end_ / 1'000'000ULL + 1ULL),
      IsoTimestamp::displayTimeZone());

  for (auto* edit :
       {ui->dateTimeStart, ui->dateTimeStartNew,
        ui->dateTimeEnd, ui->dateTimeEndNew})
  {
    edit->setMinimumDateTime(epoch);
    edit->setMaximumDateTime(maximum);
#if QT_VERSION >= QT_VERSION_CHECK(6, 10, 0)
    edit->setTimeZone(IsoTimestamp::displayTimeZone());
#else
    edit->setTimeSpec(Qt::TimeSpec::OffsetFromUTC);
#endif
  }
  ui->dateTimeStart->setDateTime(start_date);
  ui->dateTimeEnd->setDateTime(end_date);
  ui->timeRangeSlider->setRange(start_date.toMSecsSinceEpoch(),
                                end_date.toMSecsSinceEpoch());
  ui->timeRangeSlider->setValues(
      start_date.toMSecsSinceEpoch(),
      end_date.toMSecsSinceEpoch());
  ui->dateTimeStartNew->setMinimumDateTime(start_date);
  ui->dateTimeStartNew->setMaximumDateTime(end_date);
  ui->dateTimeEndNew->setMinimumDateTime(start_date);
  ui->dateTimeEndNew->setMaximumDateTime(end_date);
  on_buttonResetTimeRange_clicked();

  ui->rangeSection->setEnabled(true);
  ui->widgetSave->setEnabled(true);
  updateTopicSelectionSummary();
  updateExportAvailability();
  configureVideoPreview();
  setWindowTitle(
      QStringLiteral("%1 — MCAP Slice")
          .arg(QFileInfo(file_opened_).fileName()));

  if (source_metadata_error_.isEmpty())
  {
    statusBar()->showMessage(
        QStringLiteral("Loaded %1")
            .arg(QFileInfo(file_opened_).fileName()),
        4000);
  }
  else
  {
    statusBar()->showMessage(
        QStringLiteral("Loaded with a Metadata warning"), 6000);
  }
}

void MainWindow::configureVideoPreview()
{
#ifdef USING_WASM
  return;
#else
  QVector<VideoPreviewWidget::Stream> streams;
  mcap::ChannelId preferred_channel = 0;
  int preferred_score = -1;

  for (const auto& [channel_id, channel] : channel_by_id_)
  {
    const auto schema_it = schema_by_id_.find(channel.schema_id);
    if (schema_it == schema_by_id_.end() ||
        schema_it->second.name != "sensor_msgs/msg/CompressedImage" ||
        channel.message_encoding != "cdr")
    {
      continue;
    }

    const QString topic = QString::fromStdString(channel.topic);
    if (topic.contains(QStringLiteral("depth"), Qt::CaseInsensitive))
    {
      continue;
    }

    streams.push_back(
        {static_cast<quint16>(channel_id), topic});

    int score = 0;
    if (topic.contains(QStringLiteral("color"), Qt::CaseInsensitive))
    {
      score += 1;
    }
    if (topic.contains(QStringLiteral("head"), Qt::CaseInsensitive))
    {
      score += 2;
    }
    if (topic == QStringLiteral("/hal/camera/head/color/compressed"))
    {
      score = 10;
    }
    if (score > preferred_score)
    {
      preferred_score = score;
      preferred_channel = channel_id;
    }
  }

  ui->videoPreview->setStreams(streams,
                               static_cast<quint16>(preferred_channel));
  if (!streams.isEmpty())
  {
    const auto selected =
        std::find_if(streams.cbegin(), streams.cend(),
                     [preferred_channel](const VideoPreviewWidget::Stream& stream) {
                       return stream.channel_id == preferred_channel;
                     });
    const auto& stream =
        selected == streams.cend() ? streams.front() : *selected;
    beginVideoIndex(static_cast<mcap::ChannelId>(stream.channel_id),
                    stream.topic);
  }
#endif
}

void MainWindow::resetVideoPreview()
{
  ++video_generation_;
  video_frames_.clear();
  active_video_channel_ = 0;
  active_video_topic_.clear();
  video_decode_in_flight_ = false;
  pending_video_frame_index_ = -1;
  ui->videoPreview->reset();
}

void MainWindow::beginVideoIndex(mcap::ChannelId channel_id,
                                 const QString& topic)
{
#ifdef USING_WASM
  Q_UNUSED(channel_id);
  Q_UNUSED(topic);
  return;
#else
  ++video_generation_;
  const quint64 generation = video_generation_;
  active_video_channel_ = channel_id;
  active_video_topic_ = topic;
  video_frames_.clear();
  video_decode_in_flight_ = false;
  pending_video_frame_index_ = -1;
  ui->videoPreview->setIndexing(topic);

  const QString filename = file_opened_;
  const std::string topic_name = topic.toStdString();
  QPointer<MainWindow> guard(this);

  QThreadPool::globalInstance()->start(
      [guard, generation, filename, channel_id, topic_name]() {
        std::vector<VideoFrameInfo> frames;
        QString error_message;

        mcap::McapReader reader;
        auto status = reader.open(filename.toStdString());
        if (status.ok())
        {
          status =
              reader.readSummary(mcap::ReadSummaryMethod::AllowFallbackScan);
        }

        if (!status.ok())
        {
          error_message = QString::fromStdString(status.message);
        }
        else
        {
          mcap::ReadMessageOptions options;
          options.topicFilter = [topic_name](std::string_view candidate) {
            return candidate == topic_name;
          };
          mcap::ProblemCallback problem =
              [&error_message](const mcap::Status& problem_status) {
                if (error_message.isEmpty())
                {
                  error_message =
                      QString::fromStdString(problem_status.message);
                }
              };

          for (const auto& view : reader.readMessages(problem, options))
          {
            if (view.channel->id != channel_id)
            {
              continue;
            }
            frames.push_back({view.message.logTime,
                              view.message.publishTime,
                              view.message.sequence});
          }
          std::sort(frames.begin(), frames.end(),
                    [](const VideoFrameInfo& left,
                       const VideoFrameInfo& right) {
                      if (left.log_time != right.log_time)
                      {
                        return left.log_time < right.log_time;
                      }
                      if (left.sequence != right.sequence)
                      {
                        return left.sequence < right.sequence;
                      }
                      return left.publish_time < right.publish_time;
                    });
        }

        if (!guard)
        {
          return;
        }
        QMetaObject::invokeMethod(
            guard.data(),
            [guard, generation, frames = std::move(frames),
             error_message = std::move(error_message)]() mutable {
              if (!guard || guard->video_generation_ != generation)
              {
                return;
              }
              if (!error_message.isEmpty())
              {
                guard->ui->videoPreview->setFrameError(0, error_message);
                return;
              }

              guard->video_frames_ = std::move(frames);
              QVector<quint64> frame_times;
              frame_times.reserve(
                  static_cast<qsizetype>(guard->video_frames_.size()));
              for (const auto& frame : guard->video_frames_)
              {
                frame_times.push_back(frame.log_time);
              }
              guard->ui->videoPreview->setFrameTimeline(
                  frame_times, guard->time_start_, guard->time_end_);
              guard->updateVideoTrimRange();
              guard->ui->videoPreview->seekToTimestamp(
                  static_cast<quint64>(
                      guard->ui->dateTimeStartNew->dateTime()
                          .toMSecsSinceEpoch()) *
                  1'000'000ULL);
              guard->statusBar()->showMessage(
                  QStringLiteral("Indexed %1 video frames")
                      .arg(guard->video_frames_.size()),
                  3000);
            },
            Qt::QueuedConnection);
      });
#endif
}

void MainWindow::requestVideoFrame(int frame_index)
{
#ifdef USING_WASM
  Q_UNUSED(frame_index);
  return;
#else
  if (frame_index < 0 ||
      frame_index >= static_cast<int>(video_frames_.size()))
  {
    return;
  }

  pending_video_frame_index_ = frame_index;
  if (!video_decode_in_flight_)
  {
    startPendingVideoDecode();
  }
#endif
}

void MainWindow::startPendingVideoDecode()
{
#ifdef USING_WASM
  return;
#else
  if (pending_video_frame_index_ < 0 ||
      pending_video_frame_index_ >= static_cast<int>(video_frames_.size()))
  {
    return;
  }

  const int frame_index = pending_video_frame_index_;
  pending_video_frame_index_ = -1;
  video_decode_in_flight_ = true;

  const quint64 generation = video_generation_;
  const VideoFrameInfo frame = video_frames_[frame_index];
  const QString filename = file_opened_;
  const mcap::ChannelId channel_id = active_video_channel_;
  const std::string topic_name = active_video_topic_.toStdString();
  QPointer<MainWindow> guard(this);

  QThreadPool::globalInstance()->start(
      [guard, generation, filename, channel_id, topic_name, frame,
       frame_index]() {
        QImage decoded_image;
        QString format;
        QString frame_id;
        qint64 capture_time_ns = 0;
        QString error_message;

        mcap::McapReader reader;
        auto status = reader.open(filename.toStdString());
        if (status.ok())
        {
          status =
              reader.readSummary(mcap::ReadSummaryMethod::AllowFallbackScan);
        }

        if (!status.ok())
        {
          error_message = QString::fromStdString(status.message);
        }
        else
        {
          mcap::ReadMessageOptions options;
          options.startTime = frame.log_time;
          options.endTime =
              frame.log_time < mcap::MaxTime ?
                  frame.log_time + 1 :
                  mcap::MaxTime;
          options.topicFilter = [topic_name](std::string_view candidate) {
            return candidate == topic_name;
          };
          mcap::ProblemCallback problem =
              [&error_message](const mcap::Status& problem_status) {
                if (error_message.isEmpty())
                {
                  error_message =
                      QString::fromStdString(problem_status.message);
                }
              };

          bool found = false;
          for (const auto& view : reader.readMessages(problem, options))
          {
            if (view.channel->id != channel_id ||
                view.message.logTime != frame.log_time ||
                view.message.sequence != frame.sequence ||
                view.message.publishTime != frame.publish_time)
            {
              continue;
            }

            found = true;
            Ros2CompressedImage compressed;
            if (!Ros2CompressedImageDecoder::decode(
                    view.message.data, view.message.dataSize, compressed,
                    error_message))
            {
              break;
            }

            decoded_image = QImage::fromData(compressed.encoded_image);
            if (decoded_image.isNull())
            {
              error_message =
                  QStringLiteral("Qt could not decode the compressed image "
                                 "payload.");
              break;
            }

            format = compressed.format;
            frame_id = compressed.frame_id;
            capture_time_ns = compressed.capture_time_ns;
            break;
          }
          if (!found && error_message.isEmpty())
          {
            error_message =
                QStringLiteral("The selected video frame was not found.");
          }
        }

        if (!guard)
        {
          return;
        }
        QMetaObject::invokeMethod(
            guard.data(),
            [guard, generation, frame_index,
             decoded_image = std::move(decoded_image),
             format = std::move(format), frame_id = std::move(frame_id),
             capture_time_ns,
             error_message = std::move(error_message)]() mutable {
              if (!guard || guard->video_generation_ != generation)
              {
                return;
              }

              guard->video_decode_in_flight_ = false;
              if (error_message.isEmpty())
              {
                guard->ui->videoPreview->setFrame(
                    decoded_image, frame_index, format, frame_id,
                    capture_time_ns);
              }
              else
              {
                guard->ui->videoPreview->setFrameError(frame_index,
                                                       error_message);
              }

              if (guard->pending_video_frame_index_ >= 0)
              {
                guard->startPendingVideoDecode();
              }
            },
            Qt::QueuedConnection);
      });
#endif
}

void MainWindow::updateVideoTrimRange()
{
  const qint64 start_ms =
      ui->dateTimeStartNew->dateTime().toMSecsSinceEpoch();
  const qint64 end_ms =
      ui->dateTimeEndNew->dateTime().toMSecsSinceEpoch();
  if (start_ms < 0 || end_ms < 0)
  {
    return;
  }
  ui->videoPreview->setTrimRange(
      static_cast<quint64>(start_ms) * 1'000'000ULL,
      static_cast<quint64>(end_ms) * 1'000'000ULL);
}

void MainWindow::on_buttonResetTimeRange_clicked()
{
  auto start = ui->dateTimeStart->dateTime();
  auto end = ui->dateTimeEnd->dateTime();

  ui->dateTimeStartNew->setDateTime(start);
  ui->dateTimeEndNew->setDateTime(end);
  updateVideoTrimRange();
  ui->videoPreview->seekToTimestamp(
      static_cast<quint64>(start.toMSecsSinceEpoch()) * 1'000'000ULL);
  updateExportAvailability();
}

void MainWindow::on_tableTopics_itemSelectionChanged()
{
  QModelIndexList selection = ui->tableTopics->selectionModel()->selectedRows();

  ui->textSchema->setPlainText("");

  if (selection.count() == 1)
  {
    QModelIndex index = selection.front();
    const auto channel_id = static_cast<mcap::ChannelId>(
        ui->tableTopics->item(index.row(), 0)->data(Qt::UserRole).toUInt());
    const auto channel_it = channel_by_id_.find(channel_id);
    if (channel_it != channel_by_id_.end() && channel_it->second.schema_id != 0)
    {
      const auto schema_it = schema_by_id_.find(channel_it->second.schema_id);
      if (schema_it != schema_by_id_.end())
      {
        const auto& data = schema_it->second.data;
        ui->textSchema->setPlainText(
            QString::fromUtf8(reinterpret_cast<const char*>(data.data()),
                              static_cast<qsizetype>(data.size())));
      }
    }
  }
}

void MainWindow::on_tableTopics_itemChanged(
    QTableWidgetItem* item)
{
  if (populating_topics_ || item == nullptr || item->column() != 0)
  {
    return;
  }

  const std::string topic = item->text().toStdString();
  const Qt::CheckState state = item->checkState();
  if (state == Qt::Checked)
  {
    selected_topics_.insert(topic);
  }
  else
  {
    selected_topics_.erase(topic);
  }

  populating_topics_ = true;
  {
    const QSignalBlocker blocker(ui->tableTopics);
    for (int row = 0; row < ui->tableTopics->rowCount(); ++row)
    {
      auto* candidate = ui->tableTopics->item(row, 0);
      if (candidate != nullptr &&
          candidate->text().toStdString() == topic &&
          candidate->checkState() != state)
      {
        candidate->setCheckState(state);
      }
    }
  }
  populating_topics_ = false;
  updateTopicSelectionSummary();
  updateExportAvailability();
}

std::set<std::string>
MainWindow::selectedTopicsPresentInCurrentFile() const
{
  std::set<std::string> present;
  for (const auto& [_, channel] : channel_by_id_)
  {
    if (selected_topics_.count(channel.topic) != 0)
    {
      present.insert(channel.topic);
    }
  }
  return present;
}

void MainWindow::updateTopicSelectionSummary()
{
  const auto present = selectedTopicsPresentInCurrentFile();
  ui->labelTopics->setText(
      QStringLiteral("Topics · %1 selected").arg(present.size()));
  ui->buttonToggleSelected->setEnabled(!present.empty());
}

void MainWindow::updateExportAvailability()
{
  const bool valid_range =
      ui->dateTimeStartNew->dateTime() <
      ui->dateTimeEndNew->dateTime();
  ui->buttonSave->setEnabled(
      !file_opened_.isEmpty() && valid_range &&
      !selectedTopicsPresentInCurrentFile().empty());
}

MainWindow::WriteResult MainWindow::writeMCAP(mcap::McapWriter& writer,
                                              QString& error_message)
{
  std::set<mcap::ChannelId> selected_channels;

  for (int row = 0; row < ui->tableTopics->rowCount(); row++)
  {
    auto item = ui->tableTopics->item(row, 0);
    if (item->checkState() == Qt::Checked)
    {
      selected_channels.insert(
          static_cast<mcap::ChannelId>(item->data(Qt::UserRole).toUInt()));
    }
  }

  std::map<mcap::SchemaId, mcap::SchemaId> old_to_new_schema_id;
  std::map<mcap::ChannelId, mcap::ChannelId> old_to_new_channel_id;
  std::set<std::string> exported_topics;

  for (const auto old_channel_id : selected_channels)
  {
    const auto& channel_info = channel_by_id_.at(old_channel_id);
    mcap::SchemaId new_schema_id = 0;

    if (channel_info.schema_id != 0)
    {
      auto schema_it = old_to_new_schema_id.find(channel_info.schema_id);
      if (schema_it == old_to_new_schema_id.end())
      {
        const auto& schema = schema_by_id_.at(channel_info.schema_id);
        mcap::Schema mcap_schema(schema.name, schema.encoding, schema.data);
        writer.addSchema(mcap_schema);
        schema_it =
            old_to_new_schema_id.insert({channel_info.schema_id, mcap_schema.id}).first;
      }
      new_schema_id = schema_it->second;
    }

    mcap::Channel channel(channel_info.topic, channel_info.message_encoding,
                          new_schema_id, channel_info.metadata);
    writer.addChannel(channel);
    old_to_new_channel_id.insert({old_channel_id, channel.id});
    exported_topics.insert(channel_info.topic);
  }

  mcap::ReadMessageOptions options;
  options.topicFilter = [exported_topics](std::string_view topic) {
    return exported_topics.count(std::string(topic)) != 0;
  };
  mcap::ProblemCallback problem = [&error_message](const mcap::Status& status) {
    if (error_message.isEmpty())
    {
      error_message = QString::fromStdString(status.message);
    }
  };

  if (ui->dateTimeStart->dateTime() != ui->dateTimeStartNew->dateTime())
  {
    options.startTime = ui->dateTimeStartNew->dateTime().toMSecsSinceEpoch() * 1000000;
  }
  if (ui->dateTimeEnd->dateTime() != ui->dateTimeEndNew->dateTime())
  {
    options.endTime = ui->dateTimeEndNew->dateTime().toMSecsSinceEpoch() * 1000000;
  }

  QProgressDialog progress("Exporting messages…", "Cancel", 0, 0, this);
  progress.setWindowTitle("Exporting MCAP");
  progress.setWindowModality(Qt::WindowModal);
  progress.show();

  mcap::McapReader reader;
  mcap::Status read_status;
#ifdef USING_WASM
  mcap::BufferReader read_buffer;
  read_buffer.reset(reinterpret_cast<const std::byte*>(read_buffer_.data()),
                    read_buffer_.size(), read_buffer_.size());
  read_status = reader.open(read_buffer);
#else
  read_status = reader.open(file_opened_.toStdString());
#endif

  if (!read_status.ok())
  {
    error_message = QString::fromStdString(read_status.message);
    return WriteResult::Failed;
  }

  int count = 0;

  for (const auto& msg : reader.readMessages(problem, options))
  {
    if (selected_channels.count(msg.channel->id) == 0)
    {
      continue;
    }

    mcap::Message new_msg = msg.message;
    new_msg.channelId = old_to_new_channel_id.at(msg.channel->id);
    auto status = writer.write(new_msg);
    if (!status.ok())
    {
      error_message = QString::fromStdString(status.message);
      return WriteResult::Failed;
    }
    if (count++ % 100 == 0)
    {
      QCoreApplication::processEvents();
    }
    if (progress.wasCanceled())
    {
      return WriteResult::Canceled;
    }
  }

  for (const auto& metadata : source_metadata_)
  {
    const auto status = writer.write(metadata);
    if (!status.ok())
    {
      error_message =
          QStringLiteral("Unable to preserve source Metadata: %1")
              .arg(QString::fromStdString(status.message));
      return WriteResult::Failed;
    }
  }

  const uint64_t slice_start_ns =
      static_cast<uint64_t>(
          ui->dateTimeStartNew->dateTime().toMSecsSinceEpoch()) *
      1'000'000ULL;
  const uint64_t slice_end_ns =
      static_cast<uint64_t>(
          ui->dateTimeEndNew->dateTime().toMSecsSinceEpoch()) *
      1'000'000ULL;
  QJsonArray selected_topics_json;
  for (const auto& topic : exported_topics)
  {
    selected_topics_json.append(QString::fromStdString(topic));
  }

  mcap::Metadata provenance;
  provenance.name = "mcap_slice.provenance.v1";
  provenance.metadata = {
      {"tool.name", "MCAP Slice"},
      {"tool.version", MCAP_SLICE_VERSION},
      {"source.file_name",
       QFileInfo(file_opened_).fileName().toStdString()},
      {"source.file_size_bytes", std::to_string(source_file_size_)},
      {"source.message_start_time",
       IsoTimestamp::formatNanoseconds(time_start_).toStdString()},
      {"source.message_start_time_ns", std::to_string(time_start_)},
      {"source.message_end_time",
       IsoTimestamp::formatNanoseconds(time_end_).toStdString()},
      {"source.message_end_time_ns", std::to_string(time_end_)},
      {"slice.start_time",
       IsoTimestamp::formatNanoseconds(slice_start_ns).toStdString()},
      {"slice.start_time_ns", std::to_string(slice_start_ns)},
      {"slice.end_time_exclusive",
       IsoTimestamp::formatNanoseconds(slice_end_ns).toStdString()},
      {"slice.end_time_exclusive_ns", std::to_string(slice_end_ns)},
      {"slice.selected_topics_json",
       QJsonDocument(selected_topics_json)
           .toJson(QJsonDocument::Compact)
           .toStdString()},
      {"slice.created_at",
       IsoTimestamp::formatMilliseconds(
           QDateTime::currentMSecsSinceEpoch())
           .toStdString()},
  };
  const auto provenance_status = writer.write(provenance);
  if (!provenance_status.ok())
  {
    error_message =
        QStringLiteral("Unable to write provenance Metadata: %1")
            .arg(QString::fromStdString(provenance_status.message));
    return WriteResult::Failed;
  }
  progress.close();

  if (!error_message.isEmpty())
  {
    return WriteResult::Failed;
  }
  return WriteResult::Success;
}

void MainWindow::on_buttonToggleSelected_clicked()
{
  selected_topics_.clear();
  populating_topics_ = true;
  {
    const QSignalBlocker blocker(ui->tableTopics);
    for (int row = 0; row < ui->tableTopics->rowCount(); ++row)
    {
      auto* item = ui->tableTopics->item(row, 0);
      if (item != nullptr)
      {
        item->setCheckState(Qt::Unchecked);
      }
    }
  }
  populating_topics_ = false;
  updateTopicSelectionSummary();
  updateExportAvailability();
}

bool MainWindow::validateExportSettings()
{
  if (file_opened_.isEmpty())
  {
    QMessageBox::warning(this, "No MCAP loaded", "Load an MCAP file before exporting.");
    return false;
  }

  if (ui->dateTimeStartNew->dateTime() >= ui->dateTimeEndNew->dateTime())
  {
    QMessageBox::warning(this, "Invalid time range",
                         "The start time must be earlier than the end time.");
    return false;
  }

  if (!source_metadata_error_.isEmpty())
  {
    QMessageBox::warning(
        this, "Unable to preserve source Metadata",
        source_metadata_error_ +
            QStringLiteral(
                "\n\nExport was stopped so source provenance is not "
                "silently lost."));
    return false;
  }

  for (int row = 0; row < ui->tableTopics->rowCount(); ++row)
  {
    if (ui->tableTopics->item(row, 0)->checkState() == Qt::Checked)
    {
      return true;
    }
  }

  QMessageBox::warning(this, "No topics selected",
                       "Select at least one topic to export.");
  return false;
}

void MainWindow::dragEnterEvent(QDragEnterEvent* event)
{
#ifndef USING_WASM
  const auto urls = event->mimeData()->urls();
  if (urls.size() == 1 && urls.front().isLocalFile())
  {
    const QFileInfo info(urls.front().toLocalFile());
    if (info.isDir() ||
        (info.isFile() &&
         info.suffix().compare("mcap", Qt::CaseInsensitive) == 0))
    {
      event->acceptProposedAction();
    }
  }
#else
  Q_UNUSED(event);
#endif
}

void MainWindow::dropEvent(QDropEvent* event)
{
#ifndef USING_WASM
  const auto urls = event->mimeData()->urls();
  if (urls.size() == 1 && urls.front().isLocalFile())
  {
    const QString path = urls.front().toLocalFile();
    if (QFileInfo(path).isDir())
    {
      openFolderPath(path);
    }
    else
    {
      openFilePath(path);
    }
    event->acceptProposedAction();
  }
#else
  Q_UNUSED(event);
#endif
}
