cmake_minimum_required(VERSION 3.16)
project(
    mcap_slice
    VERSION 0.1.0
    DESCRIPTION "A lightweight desktop app for trimming and filtering MCAP files"
    LANGUAGES C CXX
)

include(GNUInstallDirs)
include(CTest)

set(ZSTD_MULTITHREAD_SUPPORT OFF CACHE BOOL "Enable Zstandard multithreading" FORCE)
set(LZ4_BUILD_LEGACY_LZ4C OFF CACHE BOOL "Build legacy lz4c" FORCE)
set(LZ4_BUILD_CLI OFF CACHE BOOL "Build the lz4 CLI" FORCE)
set(LZ4_BUNDLED_MODE ON CACHE BOOL "Build LZ4 as a bundled dependency" FORCE)

add_subdirectory(3rdparty/zstd-1.5.5)
add_subdirectory(3rdparty/lz4-1.9.4/build/cmake)

set(CMAKE_AUTOUIC ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(QT_WASM_EXTRA_EXPORTED_METHODS specialHTMLTargets)

find_package(Qt6 REQUIRED COMPONENTS Widgets)

qt_add_executable(mcap_slice
    MACOSX_BUNDLE
    WIN32
    src/main.cpp
    src/isodatetimeedit.cpp
    src/isodatetimeedit.h
    src/mainwindow.cpp
    src/mainwindow.h
    src/mainwindow.ui
    src/ros2_compressed_image.cpp
    src/ros2_compressed_image.h
    src/timerangeslider.cpp
    src/timerangeslider.h
    src/videopreviewwidget.cpp
    src/videopreviewwidget.h
    src/mcap_impl.cpp
    src/bytearray_writable.hpp
    src/resources.qrc)

target_link_libraries(mcap_slice PRIVATE
    Qt::Core
    Qt::Gui
    Qt::Widgets
    libzstd_static
    lz4_static
)

target_compile_definitions(
    mcap_slice
    PRIVATE MCAP_SLICE_VERSION="${PROJECT_VERSION}"
)

if(EMSCRIPTEN)
    target_compile_definitions(mcap_slice PRIVATE USING_WASM=1)
endif()

target_include_directories(mcap_slice PRIVATE
     $<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/src>
     $<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/3rdparty>
     $<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/3rdparty/lz4-1.9.4/lib>
     $<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/3rdparty/zstd-1.5.5>
     $<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/3rdparty/mcap-1.3.0/include>
)

if(EMSCRIPTEN)
    target_link_options(mcap_slice PUBLIC -sASYNCIFY)
endif()

set_target_properties(mcap_slice PROPERTIES
    MACOSX_BUNDLE_BUNDLE_NAME "MCAP Slice"
    MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
    MACOSX_BUNDLE_GUI_IDENTIFIER "com.tang617.mcap-slice"
    MACOSX_BUNDLE_COPYRIGHT "Copyright © 2026 TANG617 and contributors"
)

if(APPLE)
    set(MCAP_SLICE_ICON "${CMAKE_CURRENT_SOURCE_DIR}/resources/macos/MCAPSlice.icns")
    set_source_files_properties(
        "${MCAP_SLICE_ICON}"
        PROPERTIES MACOSX_PACKAGE_LOCATION "Resources"
    )
    target_sources(mcap_slice PRIVATE "${MCAP_SLICE_ICON}")
    set_target_properties(mcap_slice PROPERTIES
        OUTPUT_NAME "MCAP Slice"
        MACOSX_BUNDLE_ICON_FILE "MCAPSlice.icns"
        MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/cmake/Info.plist.in"
    )
else()
    set_target_properties(mcap_slice PROPERTIES OUTPUT_NAME "mcap-slice")
endif()

install(
    TARGETS mcap_slice
    BUNDLE DESTINATION .
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)

if(UNIX AND NOT APPLE)
    install(
        FILES packaging/linux/mcap-slice.desktop
        DESTINATION ${CMAKE_INSTALL_DATADIR}/applications
    )
    install(
        FILES src/mcap_slice.svg
        DESTINATION ${CMAKE_INSTALL_DATADIR}/icons/hicolor/scalable/apps
        RENAME mcap-slice.svg
    )
endif()

if(BUILD_TESTING)
    qt_add_executable(mcap_slice_iso_test
        tests/isodatetimeedit_test.cpp
        src/isodatetimeedit.cpp
        src/isodatetimeedit.h
    )
    target_link_libraries(mcap_slice_iso_test PRIVATE Qt::Widgets)
    target_include_directories(mcap_slice_iso_test PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}/src"
    )
    add_test(NAME iso_timestamp COMMAND mcap_slice_iso_test)
    set_tests_properties(
        iso_timestamp
        PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen"
    )
endif()
